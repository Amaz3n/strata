"""Offline TF2DeepFloorplan probe, using the author's published TFLite weights.

Independent inference adapter; no downloaded Python code is executed.
Room regions use boundary connectivity, not the room-type class alone.
"""
import argparse
import hashlib
import json
import time
from pathlib import Path
import cv2
import numpy as np
from PIL import Image
import tensorflow as tf


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--image', type=Path, required=True)
    p.add_argument('--weights', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--crop', nargs=4, type=int)
    p.add_argument('--feet-per-pixel', type=float, required=True)
    args = p.parse_args()
    if not np.isfinite(args.feet_per_pixel) or args.feet_per_pixel <= 0:
        p.error('scale must be finite and positive')
    source = Image.open(args.image).convert('RGB')
    box = args.crop or [0, 0, source.width, source.height]
    left, top, right, bottom = box
    if not 0 <= left < right <= source.width or not 0 <= top < bottom <= source.height:
        p.error('invalid crop')
    image = source.crop(box)
    model = tf.lite.Interpreter(model_path=str(args.weights), num_threads=4)
    model.allocate_tensors()
    inputs = model.get_input_details()
    if list(inputs[0]['shape']) != [1, 512, 512, 3] or inputs[0]['dtype'] != np.float32:
        raise ValueError('Unexpected input contract')
    # The published model uses square resize, RGB /255, with no ImageNet normalization.
    tensor = tf.image.resize(np.asarray(image), [512, 512]).numpy().astype(np.float32)[None] / 255
    model.set_tensor(inputs[0]['index'], tensor)
    start = time.perf_counter()
    model.invoke()
    elapsed = time.perf_counter() - start
    outputs = [model.get_tensor(d['index']) for d in model.get_output_details()]
    boundary = next(v for v in outputs if v.shape[-1] == 3)
    rooms = next(v for v in outputs if v.shape[-1] == 9)
    if boundary.shape[1:3] != (512,512) or rooms.shape[1:3] != (512,512):
        raise ValueError(f'Unexpected output dimensions: {[v.shape for v in outputs]}')
    boundary = tf.image.resize(boundary, [image.height,image.width]).numpy()[0].argmax(-1).astype(np.uint8)
    room_types = tf.image.resize(rooms, [image.height,image.width]).numpy()[0].argmax(-1).astype(np.uint8)
    args.output.mkdir(parents=True, exist_ok=True)
    Image.fromarray(boundary).save(args.output/'boundary-mask.png')
    Image.fromarray(room_types).save(args.output/'room-type-mask.png')
    overlay=np.asarray(source).copy()
    section=overlay[top:bottom,left:right]
    for index,color in [(1,np.array([255,160,0])),(2,np.array([245,50,70]))]:
        selected=boundary==index
        section[selected]=(section[selected]*.35+color*.65).astype(np.uint8)
    Image.fromarray(overlay).save(args.output/'structure-overlay.png')
    # No invented bridging: report enclosed regions under the model's raw boundaries.
    count, labels, stats, _=cv2.connectedComponentsWithStats((boundary==0).astype(np.uint8),connectivity=4)
    room_overlay=np.asarray(source).copy()
    section=room_overlay[top:bottom,left:right]
    proposed=[]
    edge=small=background=0
    for i in range(1,count):
        x,y,w,h,pixels=stats[i]
        if x==0 or y==0 or x+w==image.width or y+h==image.height:
            edge+=1;continue
        if pixels*args.feet_per_pixel**2<12:
            small+=1;continue
        region=labels==i
        inside_fraction=float((room_types[region]>0).mean())
        if inside_fraction<.5:
            background+=1;continue
        contours,hierarchy=cv2.findContours(region.astype(np.uint8),cv2.RETR_CCOMP,cv2.CHAIN_APPROX_SIMPLE)
        outer=[j for j in range(len(contours)) if hierarchy[0,j,3]==-1]
        if len(outer)!=1:continue
        def poly(c):
            return [[float((v[0]+left)*args.feet_per_pixel),float((v[1]+top)*args.feet_per_pixel)] for v in cv2.approxPolyDP(c,1,True)[:,0,:]]
        polygon=poly(contours[outer[0]])
        if len(polygon)<3:continue
        proposed.append({'id':f'r{len(proposed)+1}','polygon':polygon,'holes':[poly(contours[j]) for j in range(len(contours)) if hierarchy[0,j,3]==outer[0]],'pixelAreaSqft':float(pixels*args.feet_per_pixel**2),'insideFraction':inside_fraction})
        color=np.array([(67*i)%180+40,(113*i)%180+40,(151*i)%180+40])
        section[region]=(section[region]*.5+color*.5).astype(np.uint8)
        cv2.putText(section,proposed[-1]['id'],(x+w//2,y+h//2),cv2.FONT_HERSHEY_SIMPLEX,.7,(0,0,0),2)
    Image.fromarray(room_overlay).save(args.output/'room-overlay.png')
    report={'model':'zcemycl/TF2DeepFloorplan','weightsSha256':hashlib.sha256(args.weights.read_bytes()).hexdigest(),'sourceSha256':hashlib.sha256(args.image.read_bytes()).hexdigest(),'crop':box,'inputSize':512,'resize':'square per publisher','feetPerSourcePixel':args.feet_per_pixel,'inferenceSeconds':elapsed,'boundaryPixels':{name:int((boundary==i).sum()) for i,name in enumerate(['background','opening','wall'])},'excludedEdgeComponents':edge,'excludedSmallComponents':small,'excludedBackgroundComponents':background,'rooms':proposed,'status':'unreviewed; no accuracy or time-saving claim'}
    (args.output/'prediction.json').write_text(json.dumps(report,indent=2))
    print(json.dumps({k:v for k,v in report.items() if k!='rooms'}|{'roomCount':len(proposed),'roomPixelAreasSqft':[r['pixelAreaSqft'] for r in proposed]}))


if __name__=='__main__':
    main()
