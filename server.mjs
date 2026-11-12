import http from 'node:http';
import {createReadStream,statSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,extname,sep} from 'node:path';
import {handleApi} from './jev.mjs';
const root=fileURLToPath(new URL('.',import.meta.url));
http.createServer((req,res)=>{
 // dev only: the recorder (tools/record.js) saves its MP4 here; listens on 127.0.0.1 only
 if(req.method==='POST'&&req.url.startsWith('/api/debug/save')){const q=new URL(req.url,'http://l').searchParams,name=(q.get('name')||'').replace(/[^a-z0-9-]/gi,''),ext=['mp4','jpg','json'].includes(q.get('ext'))?q.get('ext'):'mp4';if(!name){res.writeHead(400);return res.end()}const parts=[];let size=0;req.on('data',c=>{size+=c.length;if(size>200e6)req.destroy();else parts.push(c)});req.on('end',()=>{mkdirSync(resolve(root,'tools/snaps'),{recursive:true});writeFileSync(resolve(root,'tools/snaps',name+'.'+ext),Buffer.concat(parts));res.writeHead(200);res.end('ok')});return}
 // the clips in assets/: the player's scene list and the track builder show only these (plus any you add)
 if(req.url==='/api/scenes'){let names=[];try{names=readdirSync(resolve(root,'assets')).filter(f=>/^[\w-]+\.mp4$/.test(f)&&!/-raw\.mp4$/.test(f)).map(f=>f.slice(0,-4))}catch{}res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(names))}
 if(req.url.startsWith('/api/'))return handleApi(req,res,new URL(req.url,'http://localhost').pathname);
 try{
 const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname),path=resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
 if(!path.startsWith(root.endsWith(sep)?root:root+sep)||/(^|\/)\.env/.test(pathname)){res.writeHead(403);return res.end()}
 const stat=statSync(path);if(!stat.isFile()){res.writeHead(404);return res.end()}
 const types={'.html':'text/html','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.mp4':'video/mp4','.jpg':'image/jpeg','.md':'text/plain','.json':'application/json','.wasm':'application/wasm','.webm':'video/webm'};
 const headers={'Content-Type':types[extname(path)]||'application/octet-stream','Accept-Ranges':'bytes','Cache-Control':'no-cache'};
 let start=0,end=stat.size-1,code=200;
 if(req.headers.range){const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);if(!match){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});return res.end()}
 if(!match[1])start=Math.max(0,stat.size-Number(match[2]));else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]))}
 if(start>end||start>=stat.size){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});return res.end()}
 code=206;headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;}
 headers['Content-Length']=end-start+1;res.writeHead(code,headers);if(req.method==='HEAD')return res.end();createReadStream(path,{start,end}).pipe(res);
 }catch{res.writeHead(404);res.end('Not found')}
}).listen(4173,'127.0.0.1',()=>console.log('Wisp: http://127.0.0.1:4173'));
