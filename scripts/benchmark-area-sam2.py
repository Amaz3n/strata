#!/usr/bin/env python3
"""Local segmentation diagnostic; no production integration or network calls.
Usage: python benchmark-area-sam2.py image.png checkpoint.pt prompts.json output.json
Prompts: {feetPerPixel, cases:[{label,point:[x,y],expectedSqft}], crop?:[x0,y0,x1,y1]}
Points are supplied diagnostic prompts, NOT evidence of automatic scan discovery.
Requires the official SAM 2 installation, torch, Pillow and numpy.
"""
import json,sys,time
import numpy as np
import torch
from PIL import Image
from sam2.build_sam import build_sam2
from sam2.sam2_image_predictor import SAM2ImagePredictor
image_path,checkpoint,prompt_path,output=sys.argv[1:]
prompts=json.load(open(prompt_path))
image=Image.open(image_path).convert('RGB')
crop=prompts.get('crop',[0,0,*image.size])
image=np.array(image.crop(tuple(crop)))
torch.set_num_threads(4)
start=time.perf_counter()
predictor=SAM2ImagePredictor(build_sam2('configs/sam2.1/sam2.1_hiera_t.yaml',checkpoint,device='cpu'))
results=[]
with torch.inference_mode():
    predictor.set_image(image)
    for case in prompts['cases']:
        x,y=case['point']; t=time.perf_counter()
        masks,scores,_=predictor.predict(point_coords=np.array([[x-crop[0],y-crop[1]]]),point_labels=np.array([1]),multimask_output=True)
        best=int(np.argmax(scores));mask=masks[best]
        sqft=float(mask.sum())*prompts['feetPerPixel']**2
        results.append({'label':case['label'],'expectedSqft':case['expectedSqft'],'predictedSqft':sqft,'areaErrorPct':100*abs(sqft-case['expectedSqft'])/case['expectedSqft'],'modelScoreNotCalibrated':float(scores[best]),'inferenceSeconds':time.perf_counter()-t})
        Image.fromarray((mask*255).astype('uint8')).save(output+'.'+str(len(results))+'.png')
report={'model':'SAM 2.1 Hiera tiny','mode':'manually point-prompted diagnostic, not automatic scan takeoff','device':'cpu','totalSeconds':time.perf_counter()-start,'withinTwoPercent':sum(r['areaErrorPct']<=2 for r in results),'cases':results,'qualifiedForProduction':False}
json.dump(report,open(output,'w'),indent=2)
print(json.dumps(report,indent=2))
