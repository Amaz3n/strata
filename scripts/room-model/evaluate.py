"""Local-only segmentation probe. Requires the isolated dependencies in README.

No network calls; safetensors only. Regions are proposals, never ground truth.
"""
import argparse
import hashlib
import json
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
import segmentation_models_pytorch as smp
import torch
from safetensors.torch import load_file
import yaml


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True, type=Path)
    parser.add_argument('--weights', required=True, type=Path)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--crop', nargs=4, type=int, help='left top right bottom in source-image pixels')
    parser.add_argument('--size', type=int, default=512)
    parser.add_argument('--feet-per-pixel', type=float, required=True, help='Scale of the input image, not a different-resolution sheet')
    args = parser.parse_args()
    if not np.isfinite(args.feet_per_pixel) or args.feet_per_pixel <= 0 or args.size < 128 or args.size > 2048 or args.size % 32:
        parser.error('positive scale and input size 128..2048 divisible by 32 required')
    source = Image.open(args.image).convert('RGB')
    box = args.crop or [0, 0, source.width, source.height]
    left, top, right, bottom = box
    if not (0 <= left < right <= source.width and 0 <= top < bottom <= source.height):
        parser.error('crop must be inside source image')
    image = source.crop(box)
    cfg = yaml.safe_load(args.config.read_text())
    if cfg['model']['encoder_name'] != 'resnet34' or not cfg['data']['normalize'] or not cfg['data']['letterbox']:
        raise ValueError('This adapter is for the published normalized/letterboxed ResNet34 model only')
    torch.set_num_threads(4)
    model = smp.Unet(encoder_name='resnet34', encoder_weights=None, in_channels=3, classes=4)
    model.load_state_dict(load_file(str(args.weights), device='cpu'), strict=True)
    model.eval()
    scale = min(args.size / image.width, args.size / image.height)
    width, height = max(1, round(image.width * scale)), max(1, round(image.height * scale))
    px, py = (args.size - width) // 2, (args.size - height) // 2
    rgb = np.asarray(image.resize((width, height), Image.Resampling.BILINEAR)).astype(np.float32) / 255
    normalized = (rgb - np.array([.485, .456, .406], dtype=np.float32)) / np.array([.229, .224, .225], dtype=np.float32)
    tensor = torch.zeros((1, 3, args.size, args.size))
    tensor[0, :, py:py+height, px:px+width] = torch.from_numpy(normalized.transpose(2, 0, 1).copy())
    start = time.perf_counter()
    with torch.inference_mode():
        logits = model(tensor)
        native = logits.argmax(1)[0, py:py+height, px:px+width].numpy().astype(np.uint8)
    elapsed = time.perf_counter() - start
    mask = cv2.resize(native, image.size, interpolation=cv2.INTER_NEAREST)
    args.output.mkdir(parents=True, exist_ok=True)
    Image.fromarray(mask).save(args.output / 'class-mask.png')
    # Door and window masks close openings only where the model predicts them.
    free = (mask == 0).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(free, connectivity=4)
    overlay = np.asarray(source).copy()
    crop_overlay = overlay[top:bottom, left:right]
    palette = np.array([[255,255,255],[245,50,70],[255,160,0],[0,160,245]], dtype=np.uint8)
    occupied = mask > 0
    crop_overlay[occupied] = (crop_overlay[occupied] * .35 + palette[mask[occupied]] * .65).astype(np.uint8)
    Image.fromarray(overlay).save(args.output / 'structure-overlay.png')
    room_overlay = np.asarray(source).copy()
    room_crop = room_overlay[top:bottom, left:right]
    rooms = []
    excluded_edge = 0
    excluded_small = 0
    for index in range(1, count):
        x, y, w, h, pixels = stats[index]
        if x == 0 or y == 0 or x+w == image.width or y+h == image.height:
            excluded_edge += 1
            continue
        if pixels * args.feet_per_pixel ** 2 < 12:
            excluded_small += 1
            continue
        component = (labels == index).astype(np.uint8)
        contours, hierarchy = cv2.findContours(component, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
        outer = [i for i in range(len(contours)) if hierarchy[0, i, 3] == -1]
        if len(outer) != 1:
            continue
        def polygon(contour):
            simplified = cv2.approxPolyDP(contour, 1.0, True)[:, 0, :]
            return [[float((p[0]+left)*args.feet_per_pixel), float((p[1]+top)*args.feet_per_pixel)] for p in simplified]
        points = polygon(contours[outer[0]])
        if len(points) < 3:
            continue
        holes = [polygon(contours[i]) for i in range(len(contours)) if hierarchy[0, i, 3] == outer[0]]
        rooms.append({'id': f'r{len(rooms)+1}', 'polygon': points, 'holes': holes, 'pixelAreaSqft': float(pixels*args.feet_per_pixel**2)})
        color = np.array([(67*index)%180+40, (113*index)%180+40, (151*index)%180+40])
        region = component.astype(bool)
        room_crop[region] = (room_crop[region]*.5+color*.5).astype(np.uint8)
        cv2.putText(room_crop, rooms[-1]['id'], (x+w//2,y+h//2), cv2.FONT_HERSHEY_SIMPLEX,.7,(0,0,0),2)
    Image.fromarray(room_overlay).save(args.output / 'room-overlay.png')
    report = {'model':'Yytsi/floorplan-to-3d-walls','weightsSha256':hashlib.sha256(args.weights.read_bytes()).hexdigest(), 'sourceSha256':hashlib.sha256(args.image.read_bytes()).hexdigest(), 'crop':box,'inputSize':args.size,'feetPerSourcePixel':args.feet_per_pixel,'inferenceSeconds':elapsed,'device':'cpu','classPixels':{name:int((mask==i).sum()) for i,name in enumerate(['floor','wall','door','window'])},'excludedEdgeComponents':excluded_edge,'excludedSmallComponents':excluded_small,'rooms':rooms,'status':'unreviewed proposals; no accuracy or time-saving claim'}
    (args.output/'prediction.json').write_text(json.dumps(report,indent=2))
    print(json.dumps({k:v for k,v in report.items() if k!='rooms'} | {'roomCount':len(rooms),'roomPixelAreasSqft':[r['pixelAreaSqft'] for r in rooms]}))


if __name__ == '__main__':
    main()
