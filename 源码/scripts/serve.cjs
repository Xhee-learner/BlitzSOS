"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const port = Number(process.env.BLITZSOS_PORT || 4173);
const mime = { ".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".md":"text/plain; charset=utf-8",".txt":"text/plain; charset=utf-8",".png":"image/png" };
const server = http.createServer((req,res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url,"http://127.0.0.1").pathname); }
  catch (_) { res.writeHead(400); res.end("Invalid URL"); return; }
  if (pathname === "/") pathname = "/index.html";
  const file = path.resolve(root,"." + pathname);
  const relative = path.relative(root,file);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.split(path.sep).some(x=>x.startsWith("."))) {
    res.writeHead(403);res.end("Forbidden");return;
  }
  fs.stat(file,(err,stat)=>{
    if (err || !stat.isFile()) { res.writeHead(404);res.end("Not found");return; }
    res.writeHead(200,{"Content-Type":mime[path.extname(file)]||"application/octet-stream","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"});
    fs.createReadStream(file).pipe(res);
  });
});
server.on("error",err=>{console.error(err.code==="EADDRINUSE" ? "Port 4173 is in use. Close the other preview or set BLITZSOS_PORT." : err.message);process.exitCode=1;});
server.listen(port,"127.0.0.1",()=>console.log("BlitzSOS local preview: http://127.0.0.1:"+port+" (Ctrl+C to stop)"));
