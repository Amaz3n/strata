"""Convert a local Swiss Dwellings CSV subset to reconstructed-vector fixtures.

Usage: python3 scripts/import-swiss-area-sample.py geometries.csv output-dir [--preserve-entity-types]
Input drawing edges come ONLY from separators/openings/features, never room
polygons. Room polygons supply independent truth and positioned labels.
This is NOT an original architectural-PDF benchmark.
"""
import csv
import json
import os
import re
import sys
from collections import defaultdict

def polygon(wkt):
    if not wkt.startswith('POLYGON (('):
        raise ValueError('Only polygon WKT is supported')
    return [[[float(n) for n in point.strip().split()] for point in ring.split(',')][:-1]
            for ring in re.split(r'\)\s*,\s*\(', wkt[10:-2])]

def convert(source, destination, preserve_entity_types=False):
    groups = defaultdict(list)
    with open(source) as handle:
        for row in csv.DictReader(handle):
            if row.get('site_id') and row.get('floor_id'):
                groups[(row['site_id'], row['floor_id'])].append(row)
    os.makedirs(destination, exist_ok=True)
    # One floor from each of three sites; selection fixed before examining results.
    for site, floor in [('127', '716'), ('1913', '13374'), ('85', '11138')]:
        rows = groups[(site, floor)]
        if not rows:
            raise ValueError('Sample is missing expected floor '+floor)
        parsed = [(row, polygon(row['geometry'])) for row in rows]
        points = [p for _, rings in parsed for ring in rings for p in ring]
        minx, miny = min(p[0] for p in points)-.5, min(p[1] for p in points)-.5
        maxx, maxy = max(p[0] for p in points)+.5, max(p[1] for p in points)+.5
        width, height = (maxx-minx)*100, (maxy-miny)*100
        def norm(p): return [round((p[0]-minx)*100/width,10), round((maxy-p[1])*100/height,10)]
        lines, truth, labels, paths = [], [], [], []
        for row, rings in parsed:
            normalized = []
            for ring in rings:
                clean = []
                for point in ring:
                    value = norm(point)
                    if not clean or value != clean[-1]: clean.append(value)
                if len(clean) > 1 and clean[0] == clean[-1]: clean.pop()
                if len(clean) < 3: raise ValueError('Degenerate source polygon')
                normalized.append(clean)
            if row['entity_type'] != 'area':
                for ring in normalized:
                    if preserve_entity_types:
                        subtype = row['entity_subtype']
                        layer = 'A_WALL' if subtype == 'WALL' else 'A_DOOR' if subtype in ('DOOR','ENTRANCE_DOOR') else 'A_FIXTURE_'+subtype if row['entity_type'] == 'feature' else 'A_'+subtype
                        paths.append({'id':len(paths),'commands':[['M',*ring[0]]]+[['L',*p] for p in ring[1:]]+[['Z']],
                            'kind':'stroke','layer':[layer],'color':[0],'colorSpace':'DeviceGray','opacity':1,
                            'width':.5,'dashes':[],'clips':[],'groups':[],'evenOdd':False})
                    for i,p in enumerate(ring): lines.extend(p+ring[(i+1)%len(ring)])
            elif row['entity_subtype'] not in ('SHAFT','BALCONY','STAIRS'):
                label = row['entity_subtype'].replace('_',' ').title()
                truth.append({'label':label,'points':normalized[0],'holes':normalized[1:]})
                # Label placement is a synthetic rendering choice, not a source annotation.
                center = [sum(p[i] for p in normalized[0])/len(normalized[0]) for i in range(2)]
                labels.append({'text':label,'x':center[0],'y':center[1],'w':.002,'h':.002})
        fixture = {'name':f'Swiss Dwellings site {site} floor {floor}', 'project':f'swiss-site-{site}',
            'kind':'reconstructed-public-geometry','split':'development',
            'annotationStatus':'publisher-geometry',
            'source':{'url':'https://zenodo.org/records/7070952','license':'CC-BY-4.0','attribution':'Standfest et al., Archilyse AG, Swiss Dwellings (2022)',
                'modifications':'Subset; WKT normalized and y-flipped; separators/openings/features rendered as edges; synthetic label positions. No original PDFs.'},
            'input':{'segments':lines,'textRuns':labels,'imageWidth':width,'imageHeight':height,'feetPerImagePx':1/30.48,'region':{'x0':0,'y0':0,'x1':1,'y1':1}},
            'truth':{'areas':truth}}
        if preserve_entity_types:
            fixture['input']['evidence'] = {'version':1,'truncated':False,'unrepresentedPaint':False,'paths':paths}
            fixture['input']['finishPolicy'] = 'include-fixtures'
            fixture['source']['modifications'] += ' Publisher non-area entity types retained as synthetic CAD layers; fixture footprints included to match room-polygon scope.'
        with open(os.path.join(destination,f'swiss-{site}-{floor}.json'),'w') as out: json.dump(fixture,out,separators=(',',':'))
        print(f'{floor}: {len(lines)//4} drawing edges, {len(truth)} truth areas')

if __name__ == '__main__': convert(sys.argv[1],sys.argv[2], '--preserve-entity-types' in sys.argv[3:])
