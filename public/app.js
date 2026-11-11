const $ = id => document.getElementById(id);
const state = { user:null, session:null, images:[], messages:[], busy:false, analyses:[] };
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
function setStatus(text, tone="muted") { const el=$("statusLine"); el.textContent=text; el.dataset.tone=tone; }
function renderAttachments() {
  const strip=$("attachmentStrip"); strip.replaceChildren();
  state.images.forEach((item,index)=>{
    const wrap=document.createElement("div"); wrap.className="file-chip";
    const img=document.createElement("img"); img.src=item.data; img.alt=item.name;
    const name=document.createElement("span"); name.textContent=item.name;
    const remove=document.createElement("button"); remove.textContent="×"; remove.setAttribute("aria-label","Remove screenshot");
    remove.onclick=()=>{state.images.splice(index,1);renderAttachments();syncSend()};
    wrap.append(img,name,remove); strip.append(wrap);
  });
}
function syncSend(){ $("sendButton").disabled=state.busy||(!state.images.length&&!$("messageInput").value.trim()); }
function addMessage(role, content, images=[]) {
  state.messages.push({role,content});
  const row=document.createElement("article"); row.className="chat-message "+role;
  const badge=document.createElement("div"); badge.className="message-badge"; badge.textContent=role==="user"?"YOU":"TM";
  const card=document.createElement("div"); card.className="message-card";
  const meta=document.createElement("div"); meta.className="message-meta"; meta.textContent=role==="user"?"YOU":"TRADE-ME AI";
  const body=document.createElement("div"); body.className="message-content"; body.textContent=content;
  card.append(meta,body);
  if(images.length){const gallery=document.createElement("div");gallery.className="message-gallery";images.forEach(x=>{const im=document.createElement("img");im.src=x.data;im.alt=x.name;gallery.append(im)});card.append(gallery)}
  row.append(badge,card); $("chatStream").append(row); $("chatStream").scrollTop=$("chatStream").scrollHeight;
}
function showWelcome(show){$("welcomePanel").hidden=!show}
function renderAnalysisHistory(rows){
  const list=$("analysisHistory");list.replaceChildren();
  if(!rows.length){const empty=document.createElement("div");empty.className="empty-history";empty.textContent="Your saved chart analyses will appear here.";list.append(empty);return}
  rows.forEach(row=>{
    const btn=document.createElement("button");btn.className="history-row";
    const signal=document.createElement("span");signal.className="signal-pill "+String(row.signal||"WAIT").toLowerCase();signal.textContent=row.signal||"WAIT";
    const copy=document.createElement("span");copy.className="history-copy";
    const title=document.createElement("b");title.textContent=row.symbol||"Chart analysis";
    const date=document.createElement("small");date.textContent=new Date(row.created_at).toLocaleString();
    copy.append(title,date);btn.append(signal,copy);
    btn.onclick=()=>{state.messages=[];$("chatStream").replaceChildren();showWelcome(false);addMessage("assistant",row.analysis);};
    list.append(btn);
  });
}
async function loadHistory(){
  const {data,error}=await window.tradeMeSupabase.from("trade_analyses").select("id,symbol,timeframe,prompt,analysis,signal,confidence,created_at").order("created_at",{ascending:false}).limit(12);
  if(error){console.warn("Analysis history unavailable",error.message);return}
  state.analyses=data||[];renderAnalysisHistory(state.analyses);
  if(state.analyses[0]){$("lastSignal").textContent=state.analyses[0].signal||"WAIT";$("lastSignal").className="signal-pill "+String(state.analyses[0].signal||"WAIT").toLowerCase();$("lastSignalTime").textContent=new Date(state.analyses[0].created_at).toLocaleString();}
}
async function sendAnalysis(){
  const message=$("messageInput").value.trim();
  if((!message&&!state.images.length)||state.busy)return;
  const images=state.images.slice(); const history=state.messages.slice(-12);
  showWelcome(false);addMessage("user",message||"Analyze this trading screenshot.",images);
  $("messageInput").value="";state.images=[];renderAttachments();
  state.busy=true;$("thinking").hidden=false;syncSend();setStatus("Gemini is examining the chart…","working");
  try{
    const {data:{session},error:sessionError}=await window.tradeMeSupabase.auth.getSession();
    if(sessionError||!session?.access_token)throw new Error("Your session expired. Sign in again.");
    const response=await fetch("/api/trading/analyze",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+session.access_token},body:JSON.stringify({message,history,images:images.map(x=>({name:x.name,data:x.data})),symbol:$("symbolInput").value.trim(),timeframe:$("timeframeSelect").value})});
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(result.error||"Trade-Me could not analyze this screenshot.");
    addMessage("assistant",result.reply);
    $("lastSignal").textContent=result.signal||"WAIT";$("lastSignal").className="signal-pill "+String(result.signal||"WAIT").toLowerCase();
    $("lastSignalTime").textContent=result.saved?"Saved to your account":"Analysis not saved";
    setStatus(result.saved?"Analysis complete · saved to Supabase":"Analysis complete · history save needs attention","success");
    await loadHistory();
  }catch(error){addMessage("assistant",error.message||"Something went wrong. Please retry.");setStatus(error.message||"Analysis failed","error")}
  finally{state.busy=false;$("thinking").hidden=true;syncSend();$("messageInput").focus()}
}
async function init(){
  const config=window.TRADEME_CONFIG||{};
  if(!config.supabaseUrl||!config.supabasePublishableKey||!window.supabase?.createClient){location.replace("/login");return}
  window.tradeMeSupabase=window.supabase.createClient(config.supabaseUrl,config.supabasePublishableKey);
  const {data,error}=await window.tradeMeSupabase.auth.getSession();
  if(error||!data.session?.user){location.replace("/login");return}
  state.session=data.session;state.user=data.session.user;
  $("userEmail").textContent=state.user.email||"Your account";
  $("userAvatar").textContent=(state.user.email||"T").slice(0,1).toUpperCase();
  $("signOut").onclick=async()=>{await window.tradeMeSupabase.auth.signOut();location.replace("/login")};
  $("messageInput").addEventListener("input",syncSend);
  $("messageInput").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendAnalysis()}});
  $("sendButton").onclick=sendAnalysis;
  $("imageInput").addEventListener("change",async e=>{
    const files=Array.from(e.target.files||[]);e.target.value="";
    try{
      for(const file of files){
        if(!["image/png","image/jpeg","image/webp"].includes(file.type))throw new Error("Choose a PNG, JPG or WEBP chart screenshot.");
        if(file.size>8*1024*1024)throw new Error("Each screenshot must be under 8 MB.");
        if(state.images.length>=4)throw new Error("Upload up to four screenshots at a time.");
        const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error("Could not read screenshot."));r.readAsDataURL(file)});
        state.images.push({name:file.name,data});
      }
      renderAttachments();syncSend();
    }catch(err){alert(err.message)}
  });
  $("uploadZone").addEventListener("click",e=>{if(e.target.closest("button"))return;$("imageInput").click()});
  $("uploadZone").addEventListener("dragover",e=>{e.preventDefault();$("uploadZone").classList.add("dragging")});
  $("uploadZone").addEventListener("dragleave",()=> $("uploadZone").classList.remove("dragging"));
  $("uploadZone").addEventListener("drop",async e=>{
    e.preventDefault();$("uploadZone").classList.remove("dragging");
    const files=Array.from(e.dataTransfer.files||[]);const input=$("imageInput");
    const dt=new DataTransfer();files.forEach(f=>dt.items.add(f));input.files=dt.files;input.dispatchEvent(new Event("change"));
  });
  $("clearChat").onclick=()=>{$("chatStream").replaceChildren();state.messages=[];showWelcome(true);setStatus("Ready for a new chart","muted")};
  document.querySelectorAll("[data-prompt]").forEach(btn=>btn.onclick=()=>{$("messageInput").value=btn.dataset.prompt;syncSend();$("messageInput").focus()});
  $("mobileMenu").onclick=()=> $("sidebar").classList.toggle("open");
  await loadHistory();
  try{const health=await fetch("/api/health").then(r=>r.json());$("modelLabel").textContent=health.configured?.ai?"GEMINI CONNECTED":"AI KEY REQUIRED";$("modelDot").classList.toggle("offline",!health.configured?.ai)}catch{}
  setStatus("Ready · upload a trading chart to begin","success");
  syncSend();
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();
