// Human-only screenshot viewer. No keyboard, login fields, tab switching or Done button.
export const humanCheckPage = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ask-pro human check</title>
<style>body{font:16px system-ui;margin:20px;background:#f5f7f6;color:#182421}main{max-width:1280px;margin:auto}h1{font-size:22px}img{display:block;width:100%;touch-action:manipulation}p{min-height:24px}</style>
<main><h1>Complete the human check</h1><p id="status" role="status">Connecting…</p><img id="screen" alt="Live browser. Click the human-verification checkbox."></main>
<script>
const token=location.hash.slice(1),screen=document.querySelector('#screen'),status=document.querySelector('#status');let stopped=false,frameUrl;
async function api(route,body){const r=await fetch(route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});if(!r.ok)throw Error(r.status===401?'Link expired. Ask your agent to resume ask-pro.':'Connection interrupted. Reload or ask your agent to resume ask-pro.');return r;}
function finish(){stopped=true;screen.remove();if(frameUrl)URL.revokeObjectURL(frameUrl);status.textContent='Check cleared. Return to your agent to resume ask-pro.';}
async function frame(){if(stopped)return;try{const r=await api('/frame');if(r.status===204){finish();return;}const url=URL.createObjectURL(await r.blob());screen.src=url;if(frameUrl)URL.revokeObjectURL(frameUrl);frameUrl=url;status.textContent='Click the verification checkbox in the live browser.';}catch(e){status.textContent=e.message;}if(!stopped)setTimeout(frame,500);}
screen.onclick=async e=>{const r=screen.getBoundingClientRect();try{const response=await api('/click',{x:(e.clientX-r.left)*screen.naturalWidth/r.width,y:(e.clientY-r.top)*screen.naturalHeight/r.height});if(response.status===204)finish();}catch(e){status.textContent=e.message;}};
frame();
</script></html>`;
