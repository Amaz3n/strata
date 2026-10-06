import type { AreaRecognitionRequest } from './area-engine'

/** Rendering rounds to whole pixels. Register the supplied paths to that
 * actual image frame without changing source identities or anchor indices. */
export function registerRecognitionImage(request: AreaRecognitionRequest, region: AreaRecognitionRequest['region']): AreaRecognitionRequest {
  const project = (value: number, axis: number) => axis
    ? (request.region.y0 + value * (request.region.y1 - request.region.y0) - region.y0) / (region.y1 - region.y0)
    : (request.region.x0 + value * (request.region.x1 - request.region.x0) - region.x0) / (region.x1 - region.x0);
  return {
    region,
    ...(request.wallHypotheses ? {wallHypotheses:request.wallHypotheses.map(h=>({...h,bounds:h.bounds.map((n,i)=>project(n,i%2))}))} : {}),
    ...(request.assemblies ? {assemblies:request.assemblies.map(a=>({...a,bounds:a.bounds.map((n,i)=>project(n,i%2))}))} : {}),
    ...(request.contextCatalogue ? {contextCatalogue:request.contextCatalogue.map(path=>({...path,bounds:path.bounds.map((n,i)=>project(n,i%2)),commands:path.commands.map(command=>command.map((n,i)=>i===0?n:project(Number(n),(i-1)%2)))}))} : {}),
    catalogue: request.catalogue.map(path => ({
      ...path,
      bounds: path.bounds.map((n, i) => project(n, i % 2)),
      commands: path.commands.map(command => command.map((n, i) => i === 0 ? n : project(Number(n), (i - 1) % 2))),
    })),
  };
}

/** An ID overlay is visual evidence for classification, never generated model
 * geometry. Give the provider the original crop alongside this numbered copy. */
export function recognitionOverlaySvg(request:AreaRecognitionRequest,width:number,height:number):string{
  const palette=['#d32929','#005bce','#148039','#923dc2','#c65e00','#008989']
  const paths=[...request.catalogue,...(request.contextCatalogue??[])].map((p,index)=>{
    const context=index>=request.catalogue.length, label=(context?"C ":"")+p.id
    const color=context?"#667085":palette[index%palette.length]
    const d=p.commands.map(c=>c[0]+c.slice(1).map((n,i)=>Number(n)*(i%2?height:width)).join(' ')).join(' ')
    const x=Math.max(14,Math.min(width-24,(p.bounds[0]+p.bounds[2])/2*width)),y=Math.max(14,Math.min(height-12,(p.bounds[1]+p.bounds[3])/2*height))
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.4" opacity=".85"/><g><rect x="${x-3}" y="${y-11}" width="${label.length*7+6}" height="15" rx="2" fill="white" fill-opacity=".9"/><text x="${x}" y="${y}" fill="${color}" font-family="monospace" font-size="11" font-weight="bold">${label}</text></g>`
  }).join('')
  const hypotheses=(request.wallHypotheses??[]).map(h=>{
    const [x0,y0,x1,y1]=h.bounds.map((n,i)=>n*(i%2?height:width)),label='W '+h.binding.id;
    const x=Math.max(2,Math.min(width-24,x0)),y=Math.max(12,Math.min(height-12,y0));
    return `<rect x="${x0}" y="${y0}" width="${x1-x0}" height="${y1-y0}" fill="none" stroke="#005bce" stroke-width="1" stroke-dasharray="3 2"/><text x="${x}" y="${y}" fill="#005bce" font-family="monospace" font-size="9">${label}</text>`
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${paths}${hypotheses}</svg>`
}
