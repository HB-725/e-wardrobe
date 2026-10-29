const http=require('http'),fs=require('fs'),path=require('path');
const roots=[process.argv[2],process.argv[3]];
const types={'.js':'text/javascript','.html':'text/html','.jpg':'image/jpeg','.png':'image/png','.json':'application/json','.ttf':'font/ttf','.css':'text/css'};
http.createServer((req,res)=>{
  const u=decodeURIComponent(req.url.split('?')[0]);
  let f=null;
  if(u.startsWith('/demo/')) f=path.join(roots[1],u.slice(6));
  else { const c=path.join(roots[0],u); if(fs.existsSync(c)&&fs.statSync(c).isFile()) f=c; else f=path.join(roots[0],'index.html'); }
  if(!fs.existsSync(f)){res.writeHead(404);return res.end();}
  res.writeHead(200,{'Content-Type':types[path.extname(f)]||'application/octet-stream'}); fs.createReadStream(f).pipe(res);
}).listen(8090,()=>console.log('up'));
