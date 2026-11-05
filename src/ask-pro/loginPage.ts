// The browser relays human input only. Never persist input, frames, or the access key.
export const loginPage = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ask-pro sign in</title>
<style>
:root{font:16px/1.5 system-ui;color:#182421;background:#f5f7f6}body{margin:0}main{max-width:1280px;margin:auto;padding:20px}header{display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:16px}h1{font-size:22px;margin:0 auto 0 0}button,input,select{font:inherit;padding:10px;border:1px solid #62716b;border-radius:6px;background:white;color:inherit}button{cursor:pointer}button:hover{background:#e0ebe5}:focus-visible{outline:3px solid #197451;outline-offset:2px}#screen{display:block;width:100%;background:white;touch-action:manipulation}form{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}input{flex:1;min-width:150px}#status{min-height:24px;margin:8px 0;color:#344b41}button:disabled{opacity:.6;cursor:wait}
</style><main><header><h1>Sign in to ChatGPT</h1><select id="tabs" aria-label="Browser tab"></select><button id="refresh">Refresh tabs</button><button id="done">Done</button></header>
<p id="status" role="status">Connecting…</p><img id="screen" tabindex="0" alt="Remote browser. Click a field, then type, or use the text box below.">
<form><input id="text" type="password" autocomplete="off" aria-label="Text for selected browser field" placeholder="Type into selected field"><button>Send text</button><button type="button" id="enter">Enter</button><button type="button" id="tab">Tab</button><button type="button" id="backspace">Backspace</button><button type="button" id="up">Scroll up</button><button type="button" id="down">Scroll down</button></form></main>
<script>
const token=location.hash.slice(1);
const screen=document.querySelector('#screen'),tabs=document.querySelector('#tabs'),status=document.querySelector('#status'),text=document.querySelector('#text');
let stopped=false,frameUrl,inputQueue=Promise.resolve();
async function api(route,body){const r=await fetch(route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});if(!r.ok)throw Error(r.status===401?'Link expired. Start ask-pro --login again.':'Connection failed. Retry or refresh tabs.');return r;}
function report(e){status.textContent=e.message;}
function input(body){const target=tabs.value;const request=inputQueue.then(()=>api('/input',{target,...body}));inputQueue=request.catch(report);return request;}
async function refresh(){try{const list=await(await api('/tabs')).json();const previous=tabs.value;tabs.replaceChildren(...list.map(t=>new Option(t.name,t.id)));if(list.some(t=>t.id===previous))tabs.value=previous;status.textContent='Click the browser to sign in. Select Done when the ChatGPT composer is visible.';}catch(e){report(e);}}
async function frame(){if(stopped)return;try{if(tabs.value){const r=await api('/frame?target='+encodeURIComponent(tabs.value));const url=URL.createObjectURL(await r.blob());screen.src=url;if(frameUrl)URL.revokeObjectURL(frameUrl);frameUrl=url;}}catch(e){report(e);}setTimeout(frame,350);}
screen.onclick=e=>{const r=screen.getBoundingClientRect();input({kind:'click',x:(e.clientX-r.left)*screen.naturalWidth/r.width,y:(e.clientY-r.top)*screen.naturalHeight/r.height});screen.focus();};
screen.onkeydown=e=>{if(e.ctrlKey||e.metaKey||e.altKey)return;if(e.key.length===1){e.preventDefault();input({kind:'text',text:e.key});}else if(['Enter','Tab','Backspace','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Escape','Home','End'].includes(e.key)){e.preventDefault();input({kind:'key',key:e.key});}};
screen.onwheel=e=>{e.preventDefault();const r=screen.getBoundingClientRect();input({kind:'scroll',x:(e.clientX-r.left)*screen.naturalWidth/r.width,y:(e.clientY-r.top)*screen.naturalHeight/r.height,deltaY:e.deltaY});};
document.querySelector('form').onsubmit=async e=>{e.preventDefault();const value=text.value;try{await input({kind:'text',text:value});if(text.value===value)text.value='';}catch(e){report(e);}};
for(const key of ['Enter','Tab','Backspace'])document.querySelector('#'+key.toLowerCase()).onclick=()=>input({kind:'key',key});
document.querySelector('#up').onclick=()=>input({kind:'scroll',x:100,y:100,deltaY:-400});
document.querySelector('#down').onclick=()=>input({kind:'scroll',x:100,y:100,deltaY:400});
document.querySelector('#refresh').onclick=refresh;
document.querySelector('#done').onclick=async()=>{try{await api('/done',{});stopped=true;screen.removeAttribute('src');text.value='';status.textContent='Sign-in window closed. You can return to your agent.';}catch(e){report(e);}};
refresh().then(frame);
</script></html>`;
