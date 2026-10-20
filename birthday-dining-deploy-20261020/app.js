/* Birthday Dining: reusable static frontend; shared backend via Supabase RPC (optional). */
(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const nameFor = (role) => role === 'rabbit' ? '星星菟菟' : '星星狗狗';
  const emojiFor = (role) => role === 'rabbit' ? '🐰✦' : '🐶✦';
  const otherRole = (role) => role === 'rabbit' ? 'dog' : 'rabbit';
  const baseTags = ['燒肉','餐酒館','牛舌','火鍋','甜點','精品咖啡','巧克力','吃到飽','壽司','串燒','義式','Buffet','和牛','海鮮','清酒','米其林','單點'];
  const vMap = new Map(window.VENUES.map(v => [v.id, v]));
  const config = window.DINING_CLOUD || {};
  const cloud = Boolean(config.supabaseUrl && config.publishableKey && /^https:\/\//.test(config.supabaseUrl));
  const adapter = config.adapter === 'legacy' ? 'legacy' : 'rpc';
  const state = {
    role:null, room:null, votes:{}, notes:{}, custom:[], stamps:0, sort:'quality', comparing:false,
    q:'', filters:{person:new Set(), deals:new Set(), city:new Set(), tags:new Set(), birthday:false, price:false},
    updatedAt:0, cloudOnline:false, poll:null, syncing:false
  };
  const ROT = ['rabbit','dog'];
  const BASE_FILTERS = [
    ['person','mine','我想吃'], ['person','partner','夥伴想吃'], ['person','both','雙方都想吃'],
    ['birthday','yes','10月壽星'],['deals','cube10','CUBE 10%'],['deals','autumn8','秋日遊8%'],
    ['price','yes','NT$1000內'],['city','台中','台中'],['city','台北','台北']
  ];
  const images = {yakiniku:'yakiniku',beef:'beef',bistro:'bistro',hotpot:'hotpot',spicy:'spicy',buffet:'buffet',coffee:'coffee',beer:'beer',chocolate:'chocolate',dessert:'cake',cake:'cake',pasta:'pasta',sushi:'sushi',skewers:'skewers',souffle:'souffle',setmeal:'setmeal'};

  function toast(message) {
    const el = $('#toast'); el.textContent = message; el.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, 3300);
  }
  function roomStorageKey(room){ return 'birthday-dining:room:'+room; }
  function loadRoomLocal(room){
    try {return JSON.parse(localStorage.getItem(roomStorageKey(room)) || '{}');} catch {return {};}
  }
  function saveRoomLocal(){
    if(!state.room) return;
    localStorage.setItem(roomStorageKey(state.room), JSON.stringify({votes:state.votes,notes:state.notes,stamps:state.stamps,custom:state.custom,updatedAt:Date.now()}));
  }
  function newCode() {
    const x = new Uint8Array(22); crypto.getRandomValues(x);
    return [...x].map(b => '23456789abcdefghjkmnpqrstuvwxyz'[b % 31]).join('');
  }
  function currentRoleKey(room){return 'birthday-dining:role:'+room;}
  function roomUrl(){return location.origin + location.pathname + '?room=' + encodeURIComponent(state.room || '');}
  function goToRoom(room){
    try {if(location.protocol.startsWith('http')) history.replaceState(null,'',location.pathname+'?room='+encodeURIComponent(room));}catch{}
  }
  // A separate REST adapter connects the portable frontend to the existing Lovable Cloud
  // Supabase tables; it uses only a publicly distributable publishable key, never a secret.
  // Later, switch to adapter='rpc' to use the independently hosted schema in this package.
  async function legacyRest(table, method = 'GET', query = '', payload = null, prefer = '') {
    const url = config.supabaseUrl.replace(/\/+$/, '') + '/rest/v1/' + table + (query ? '?' + query : '');
    const headers = { 'apikey': config.publishableKey, 'Accept':'application/json' };
    if(config.publishableKey.startsWith('eyJ')) headers.Authorization='Bearer ' + config.publishableKey;
    if(payload !== null) headers['Content-Type']='application/json';
    if(prefer) headers['Prefer'] = prefer;
    const res = await fetch(url, {method, headers, ...(payload !== null ? {body:JSON.stringify(payload)} : {})});
    if(!res.ok) throw Error(`${table}: HTTP ${res.status} ${(await res.text()).slice(0,160)}`);
    if(res.status === 204 || res.status === 201 && !res.headers.get('Content-Type')?.includes('json')) return null;
    const data = await res.text();
    return data ? JSON.parse(data) : null;
  }
  function toLegacyRole(role) { return role === 'rabbit' ? 'me' : 'partner'; }
  function fromLegacyRow(r) {
    return {
      id:r.id,name:r.name,city:r.city||'台中',area:r.area||'待補充',category:r.category||'其他',
      min:Number(r.price_min||0),max:Number(r.price_max??r.price_min??0),
      style:r.dining_style||'待補充',main:r.must_eat||'待補充',drinks:r.drinks||'待補充',
      dessert:r.dessert||'待補充',birthday:r.birthday||'生日優惠未核實',
      birthdayStatus:r.birthday_status||'none',cube:r.cube_tier==='regular3'?'regular':(r.cube_tier||'regular'),
      group:r.cube_group||null,quality:r.quality_note||'使用者新增・資料待查',
      distance:r.distance_km==null?null:Number(r.distance_km),tags:Array.isArray(r.tags)?r.tags:[],
      caveat:r.caveat||'未核實',image:r.image_key||'bistro',
    };
  }
  async function legacyRpc(name, args) {
    const rc=encodeURIComponent(args.p_code||'');
    if(name==='dining_create') {
      await legacyRest('rooms','POST','',{code:args.p_code},'return=minimal');
      return {created:true,code:args.p_code};
    }
    if(name==='dining_read') {
      const [rooms,votes,notes,custom] = await Promise.all([
        legacyRest('rooms','GET',`select=code,cube_stamps&code=eq.${rc}&limit=1`),
        legacyRest('votes','GET',`select=restaurant_id,role&room_code=eq.${rc}`),
        legacyRest('notes','GET',`select=restaurant_id,body&room_code=eq.${rc}`),
        legacyRest('restaurants','GET','select=*&is_user_added=eq.true')
      ]);
      if(!rooms?.length) return {exists:false};
      return {
        exists:true,stamps:rooms[0].cube_stamps||0,
        votes:(votes||[]).map(v=>({...v,role:v.role==='me'?'rabbit':'dog'})),
        notes:notes||[],
        custom:(custom||[]).map(v=>({id:v.id,payload:fromLegacyRow(v)}))
      };
    }
    if(name==='dining_vote') {
      const q=`room_code=eq.${rc}&restaurant_id=eq.${encodeURIComponent(args.p_restaurant_id)}&role=eq.${toLegacyRole(args.p_role)}`;
      if(args.p_on) await legacyRest('votes','POST','',{
        room_code:args.p_code,restaurant_id:args.p_restaurant_id,
        role:toLegacyRole(args.p_role),nickname:nameFor(args.p_role)
      },'return=minimal');
      else await legacyRest('votes','DELETE',q,null,'return=minimal');
      return {ok:true};
    }
    if(name==='dining_note') {
      const q=`room_code=eq.${rc}&restaurant_id=eq.${encodeURIComponent(args.p_restaurant_id)}`;
      if(args.p_body) {
        await legacyRest('notes','POST','on_conflict=room_code,restaurant_id',{
          room_code:args.p_code,restaurant_id:args.p_restaurant_id,
          body:args.p_body.slice(0,1000),author:nameFor(args.p_role),updated_at:new Date().toISOString()
        },'resolution=merge-duplicates,return=minimal');
      } else await legacyRest('notes','DELETE',q,null,'return=minimal');
      return {ok:true};
    }
    if(name==='dining_stamps') {
      await legacyRest('rooms','PATCH',`code=eq.${rc}`,{cube_stamps:args.p_stamps,updated_at:new Date().toISOString()},'return=minimal');
      return {ok:true};
    }
    if(name==='dining_add_restaurant') {
      const r=args.p_payload;
      await legacyRest('restaurants','POST','',{
        id:args.p_restaurant_id,name:r.name,city:r.city,area:r.area,category:r.category,
        tags:r.tags,price_min:r.min||null,price_max:r.max||null,dining_style:r.style,
        must_eat:r.main,drinks:r.drinks,dessert:r.dessert,birthday:r.birthday,
        birthday_status:r.birthdayStatus,cube_tier:'regular3',quality_level:'none',
        quality_note:r.quality,distance_km:r.distance,image_key:r.image||'bistro',
        caveat:r.caveat,is_user_added:true,quality_rank:15
      },'return=minimal');
      return {ok:true};
    }
    throw Error('不支援的雲端操作：'+name);
  }
  async function rpc(name,args) {
    if(!cloud) throw Error('尚未設定雲端資料庫');
    if(adapter==='legacy') return legacyRpc(name,args);
    const url = config.supabaseUrl.replace(/\/+$/,'') + '/rest/v1/rpc/' + name;
    const headers = {'Content-Type':'application/json','apikey':config.publishableKey};
    if(config.publishableKey.startsWith('eyJ')) headers.Authorization='Bearer '+config.publishableKey;
    const res=await fetch(url,{method:'POST',headers,body:JSON.stringify(args)});
    if(!res.ok) throw Error(name+' failed ('+res.status+'): '+(await res.text()).slice(0,200));
    return res.json();
  }
  function setSyncStatus(status,online) {
    state.cloudOnline=Boolean(online);
    const label=$('#sync-indicator');
    label.textContent=status; label.classList.toggle('online',Boolean(online));
    $('#local-only-note').textContent=cloud?'雲端已啟用，可跨手機共享；目前每4.5秒更新一次。':'目前是本機模式。先完成 Supabase 設定，兩支手機才能雲端同步。';
  }
  async function readCloud() {
    if(!cloud || !state.room || state.syncing) return;
    state.syncing = true;
    try {
      const data = await rpc('dining_read',{p_code:state.room});
      if(!data?.exists) {setSyncStatus('找不到共享房間',false);return;}
      state.votes={};
      for(const v of (data.votes || [])) {
        state.votes[v.restaurant_id] ||= {};
        state.votes[v.restaurant_id][v.role] = true;
      }
      state.notes = {};
      for(const n of (data.notes || [])) state.notes[n.restaurant_id] = n.body;
      state.stamps = Number(data.stamps || 0);
      state.custom = Array.isArray(data.custom) ? data.custom.map(x => x.payload) : [];
      state.updatedAt = Date.now(); saveRoomLocal(); render();
      setSyncStatus('雲端同步中 ✓',true);
    } catch (e) {
      console.error(e); setSyncStatus('雲端暫時離線',false);
    } finally {state.syncing=false;}
  }
  async function startRoom(role,entered) {
    const room=entered ? entered.toLowerCase().trim() : newCode();
    if(!(adapter==='legacy' ? /^[a-z0-9]{10,32}$/ : /^[a-z0-9]{16,32}$/).test(room)) throw Error('房間代碼格式不正確（10～32位英數字）。');
    if(cloud) {
      if(!entered) await rpc('dining_create',{p_code:room});
      const check=await rpc('dining_read',{p_code:room});
      if(!check?.exists) throw Error('找不到這個共享房間，請檢查夥伴提供的連結。');
    }
    state.room=room;state.role=role;
    localStorage.setItem('birthday-dining:last-room',room);
    localStorage.setItem(currentRoleKey(room),role);
    const local=loadRoomLocal(room);state.votes=local.votes || {};state.notes=local.notes || {};
    state.custom=local.custom || [];state.stamps=local.stamps || 0;
    goToRoom(room);
    $('#join-dialog').close();
    if(cloud){await readCloud();state.poll=setInterval(readCloud,4500)}
    else setSyncStatus('僅本機・未同步',false);
    render();
  }
  function showJoin() {
    $('#join-alert').hidden=true;$('#join-dialog').showModal();
    $('#join-start').disabled=true;
    $('#join-dialog').querySelectorAll('[data-role]').forEach(n => n.classList.remove('selected'));
    $('#join-dialog').dataset.role='';
  }
  function resetSelection(){
    const f=state.filters;f.person.clear();f.deals.clear();f.city.clear();f.tags.clear();f.birthday=false;f.price=false;
    state.comparing=false;state.q='';$('#search').value='';render();
  }
  function selectedCount(){const f=state.filters;return f.person.size+f.deals.size+f.city.size+f.tags.size+Number(f.birthday)+Number(f.price);}
  function match(v){
    const f=state.filters;
    const votes=state.votes[v.id] || {};
    if(state.comparing && !(votes.rabbit || votes.dog))return false;
    const normalizedSearch=[v.name,v.city,v.area,v.category,v.main,v.drinks,v.dessert,v.quality,...v.tags].join(' ').toLowerCase();
    if(state.q.trim()&&!normalizedSearch.includes(state.q.toLowerCase().trim()))return false;
    if(f.city.size && !f.city.has(v.city)) return false;
    if(f.birthday && v.birthdayStatus==='none')return false;
    if(f.price && v.min>1000)return false;
    if(f.deals.size && !([...f.deals].some(d=>v.cube===d)))return false;
    // Multiple cuisine tags are intentionally intersected for precise results.
    for (const tag of f.tags) if(!(v.tags.includes(tag) || v.category.includes(tag) || v.main.includes(tag)))return false;
    if(f.person.has('both') && !(votes.rabbit && votes.dog))return false;
    if(f.person.has('mine') && !votes[state.role])return false;
    if(f.person.has('partner') && !votes[otherRole(state.role)])return false;
    return true;
  }
  function allVenues(){return [...window.VENUES, ...state.custom]}
  function discountWeight(v){return {cube10:10,autumn8:8,autumn5:5,regular:3}[v.cube] || 0}
  function qualityWeight(v){let q=v.quality||''; return q.includes('米其林一星')?100:q.includes('米其林指南入選')?85:q.includes('冠軍')?70:q.includes('指南')?60:35;}
  function sortedList(list){return [...list].sort((a,b)=>{
    if(state.sort==='distance')return (a.city==='台北'?150:a.distance??99)-(b.city==='台北'?150:b.distance??99);
    if(state.sort==='price')return a.min-b.min;
    if(state.sort==='discount')return discountWeight(b)-discountWeight(a)||qualityWeight(b)-qualityWeight(a);
    return qualityWeight(b)-qualityWeight(a)||(a.city==='台北'?150:a.distance??99)-(b.city==='台北'?150:b.distance??99);
  })}
  function info(v){
    switch(v.cube){
      case 'cube10':return {txt:'慶生月 10%',tag:'cube',desc:`指定CUBE慶生月10%回饋／第${v.group||'?'}類，非餐費現折；10月壽星須核對實際適用期間、店家與支付方式。`};
      case 'autumn8':return {txt:'秋日遊 8%',tag:'cube',desc:'指定秋日遊8%（原活動至2026/11/30）；部分指定分店及付款方式可能排除。'};
      case 'autumn5':return {txt:'秋日遊 5%',tag:'cube',desc:'指定秋日遊5%（原活動至2026/11/30）；需檢查分店、付款方式及任何登錄條件。'};
      default:return {txt:'一般餐飲可能3%',tag:'',desc:'不是慶生月10%或秋日遊指定店。若符合Level 2「樂饗購」國內餐飲請款條件，可按該方案回饋；非所有店家都保證3%。'};
    }
  }
  function imageSrc(v){return 'assets/'+(images[v.image]||'bistro')+'.webp';}
  function cash(n){return Number(n || 0).toLocaleString('zh-TW')}
  function distance(v){return v.city==='台北'?'跨城市・台北出差':v.distance==null?'待查位置':`距台中車站約 ${Number(v.distance)} km`}
  function mapLink(v){return 'https://www.google.com/maps/dir/?api=1&origin='+encodeURIComponent('台中車站')+'&destination='+encodeURIComponent(v.name+' '+v.city+' '+v.area);}
  function cardHtml(v){
    const deal=info(v), vt=state.votes[v.id]||{}, select=state.role || 'rabbit';
    const visibleTags=[v.category,...v.tags].filter((x,i,a)=>a.indexOf(x)===i).slice(0,5);
    const bday=v.birthdayStatus!=='none';
    return `<article class="card" data-id="${esc(v.id)}"><div class="image-wrap"><img class="card-image" src="${imageSrc(v)}" alt="${esc(v.category)}料理插畫" loading="lazy"><span class="illustration-label">料理示意・非店家實拍</span><span class="deal-tag ${deal.tag}">${esc(deal.txt)}</span></div><div class="card-body"><div class="card-heading"><h3>${esc(v.name)}</h3><span class="city">${esc(v.city)}・${esc(v.area)}</span></div><div class="taglist">${visibleTags.map(t=>`<span class="tag ${t==='米其林'?'highlight':''}">#${esc(t)}</span>`).join('')}</div><p class="card-main"><b>主打：</b>${esc(v.main)}<br><b>吃法：</b>${esc(v.style)}</p><div class="meta-row"><span class="price">NT$${cash(v.min)}–${cash(v.max)}／人</span><span class="dist">${esc(distance(v))}</span></div><div class="card-quality">${esc(v.quality)}</div><p class="birthday-snippet ${bday?'':'no'}"><b>${bday?'🎁 生日禮｜':'○ 生日｜'}</b>${esc(v.birthday)}</p><div class="card-actions"><div class="vote-row">${ROT.map(role=>`<button type="button" data-vote="${role}" aria-pressed="${!!vt[role]}" class="vote ${role} ${vt[role]?'on':''} ${role!==select?'not-me':''}" ${role!==select?'title="請用另一個角色的裝置勾選"':''}>${role==='rabbit'?'🐰':'🐶'} ${esc(nameFor(role))} ${vt[role]?'♥':'♡'}</button>`).join('')}</div><div class="card-links"><button class="more" type="button" data-detail="${esc(v.id)}">查看餐點、酒類、甜點與優惠 →</button><a class="map-link" target="_blank" rel="noopener noreferrer" href="${mapLink(v)}">導航 ↗</a></div></div></div></article>`;
  }
  function renderChips(){
    const f=state.filters;$('#base-filters').innerHTML=BASE_FILTERS.map(([g,val,label])=>{
      const selected = g==='birthday'?f.birthday:g==='price'?f.price:f[g].has(val);
      return `<button class="filter-chip ${selected?'on':''}" type="button" data-group="${g}" data-value="${val}" aria-pressed="${selected}">${label}</button>`;
    }).join('');
    $('#tag-filters').innerHTML=baseTags.map(t=>`<button class="filter-chip ${f.tags.has(t)?'on':''}" type="button" data-group="tags" data-value="${esc(t)}" aria-pressed="${f.tags.has(t)}">#${esc(t)}</button>`).join('');
    $('#active-count').textContent=selectedCount()+' 個篩選';
    const list=[...([...f.person].map(x=>({mine:'我想吃',partner:'夥伴想吃',both:'雙方都想吃'})[x])),...([...f.deals].map(x=>({cube10:'CUBE 10%',autumn8:'秋日遊8%'})[x])),...f.city,...([...f.tags].map(s=>s.startsWith('#')?s:'#'+s)),...(f.birthday?['10月壽星']:[]),...(f.price?['NT$1000內']:[])];
    $('#active-preview').textContent=list.length?'已選：'+list.join(' · '):'目前顯示全部店家';
  }
  function render(){
    renderChips();
    const all=allVenues();
    let list=sortedList(all.filter(match));
    $('#count-all').textContent=all.length;
    $('#count-result').textContent=list.length;
    $('#count-both').textContent=all.filter(v=>state.votes[v.id]?.rabbit&&state.votes[v.id]?.dog).length;
    $('#vote-count').textContent=all.filter(v=>state.votes[v.id]?.rabbit || state.votes[v.id]?.dog).length;
    $('#stamps-buttons').querySelectorAll('[data-stamp]').forEach(b=>b.classList.toggle('selected',Number(b.dataset.stamp)===state.stamps));
    $('#cards').innerHTML=list.map(cardHtml).join('');
    $('#empty').hidden=list.length!==0;
    $('#compare').textContent=state.comparing?'取消比較':'比較已勾選 ('+$('#vote-count').textContent+')';
  }
  function chooseChip(group,value){
    const f=state.filters;
    if(group==='birthday')f.birthday=!f.birthday;
    else if(group==='price')f.price=!f.price;
    else if(f[group]){f[group].has(value)?f[group].delete(value):f[group].add(value)}
    render();
  }
  async function vote(id,role){
    if(state.role!==role) {toast('這是'+nameFor(role)+'的專屬勾選，請由對方的手機操作。');return;}
    const curr=!!state.votes[id]?.[role];state.votes[id]||={};state.votes[id][role]=!curr;saveRoomLocal();render();
    if(cloud)try{await rpc('dining_vote',{p_code:state.room,p_restaurant_id:id,p_role:role,p_on:!curr});await readCloud()}catch(e){toast('未能同步至雲端，請稍後重試');setSyncStatus('同步失敗',false);console.error(e);}
  }
  function detail(id){
    const v=allVenues().find(x=>x.id===id);if(!v)return;
    const perk=info(v),notes=state.notes[id]||'';
    $('#detail').innerHTML=`<img class="detail-hero" src="${imageSrc(v)}" alt="料理示意插圖"><p class="eyebrow" style="margin:14px 0 0">${esc(v.city)}・${esc(v.area)} · ${esc(v.category)}</p><h2 class="detail-title">${esc(v.name)}</h2><p class="detail-disclaimer">圖片為料理插畫示意，非店家實拍；約 NT$${cash(v.min)}–${cash(v.max)}／人；${esc(distance(v))}（台中距離為區域概算非行車距離）</p><div class="taglist">${v.tags.map(x=>`<span class="tag">#${esc(x)}</span>`).join('')}</div><div class="detail-grid"><section><label>必吃與招牌</label><p>${esc(v.main)}</p></section><section><label>用餐方式</label><p>${esc(v.style)}</p></section><section><label>酒款與飲品</label><p>${esc(v.drinks)}</p></section><section><label>甜點</label><p>${esc(v.dessert)}</p></section><section><label>料理品質證據</label><p>${esc(v.quality)}</p></section><section><label>店家生日禮</label><p>${esc(v.birthday)}</p></section></div><div class="detail-offer"><strong>${esc(perk.txt)}</strong><p style="margin:5px 0 0">${esc(perk.desc)}</p></div><p class="detail-disclaimer">使用限制：${esc(v.caveat||'需查證當期活動')}。資料以2026年10月已整理資訊為起點，並非即時保證；請以銀行與店家當期公告為準。</p><div class="detail-links"><a target="_blank" rel="noopener noreferrer" href="${mapLink(v)}">台中車站出發導航 ↗</a><a target="_blank" rel="noopener noreferrer" href="https://www.google.com/search?q=${encodeURIComponent(v.name+' '+v.city+' 官方 菜單 營業時間')}">店家資訊與菜單 ↗</a><a target="_blank" rel="noopener noreferrer" href="https://www.cathay-cube.com.tw/cathaybk/personal/event/overview/credit-card/dining/202610/cube_birthday_2026Q4">CUBE活動條款 ↗</a></div><label class="form-label" style="display:block;margin-top:18px">這間店的共同備註</label><textarea id="detail-note" class="field" rows="3" maxlength="1000" placeholder="例如：想吃牛舌、避開假日、確認生日優惠">${esc(notes)}</textarea><button class="primary wide" type="button" id="save-note">儲存共享備註</button>`;
    $('#detail-dialog').showModal();
    $('#save-note').onclick=async()=>{
      const body=$('#detail-note').value.trim();state.notes[id]=body;saveRoomLocal();toast(cloud?'正在同步備註…':'已儲存到本機');
      if(cloud)try{await rpc('dining_note',{p_code:state.room,p_restaurant_id:id,p_role:state.role,p_body:body});toast('雲端備註已儲存')}catch(e){toast('備註同步失敗，請稍後重試');console.error(e)}
    };
  }
  function createDownload(){
    const payload={exportedAt:new Date().toISOString(),room:state.room,selected:{rabbit:[],dog:[],both:[]},notes:state.notes,stamps:state.stamps};
    for(const v of allVenues()){
      if(state.votes[v.id]?.rabbit)payload.selected.rabbit.push(v.name);
      if(state.votes[v.id]?.dog)payload.selected.dog.push(v.name);
      if(state.votes[v.id]?.rabbit&&state.votes[v.id]?.dog)payload.selected.both.push(v.name);
    }
    const u=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=u;a.download='birthday-dining-selections.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),2000);
  }
  function bind(){
    $('#search').addEventListener('input',e=>{state.q=e.target.value;render()});
    $('#sort').addEventListener('change',e=>{state.sort=e.target.value;render()});
    $('#reset').onclick=$('#empty-reset').onclick=resetSelection;
    $('#base-filters').addEventListener('click',e=>{const n=e.target.closest('[data-group]');if(n)chooseChip(n.dataset.group,n.dataset.value)});
    $('#tag-filters').addEventListener('click',e=>{const n=e.target.closest('[data-group]');if(n)chooseChip(n.dataset.group,n.dataset.value)});
    $('#goto-both').onclick=()=>{resetSelection();state.filters.person.add('both');document.querySelector('.results').scrollIntoView({behavior:'smooth'});render()};
    $('#compare').onclick=()=>{state.comparing=!state.comparing;render()};
    $('#stamps-buttons').addEventListener('click',async e=>{const b=e.target.closest('[data-stamp]');if(!b)return;state.stamps=Number(b.dataset.stamp);saveRoomLocal();render();if(cloud)try{await rpc('dining_stamps',{p_code:state.room,p_stamps:state.stamps})}catch(err){toast('集章進度未能同步');console.error(err)}});
    $('#add-venue').onclick=()=>$('#add-dialog').showModal();
    $('#add-close').onclick=()=>$('#add-dialog').close();
    $('#new-save').onclick=async()=>{
      const name=$('#new-name').value.trim(),city=$('#new-city').value,category=$('#new-kind').value.trim()||'其他',main=$('#new-main').value.trim()||'待補充',min=Math.max(0,Math.min(100000,Number($('#new-price').value)||0));
      if(!name){toast('請先輸入餐廳名稱');return}
      const id='custom-'+newCode().slice(0,18);
      const image=category.includes('咖啡')?'coffee':category.includes('燒肉')?'yakiniku':category.includes('甜點')?'cake':category.includes('火鍋')?'hotpot':'bistro';
      const v={id,name,city,area:'待補充',category,min,max:min,style:'待補充',main,drinks:'待補充',dessert:'待補充',birthday:'使用者新增・尚未核實',birthdayStatus:'none',cube:'regular',group:null,quality:'使用者新增・尚無第三方品質證據',distance:null,tags:[category],caveat:'需自行確認資訊，銀行回饋不保證',image};
      state.custom.push(v);saveRoomLocal();render();$('#add-dialog').close();toast('已新增：'+name);
      if(cloud)try{await rpc('dining_add_restaurant',{p_code:state.room,p_restaurant_id:id,p_payload:v});await readCloud()}catch(err){toast('新增店家未成功同步');console.error(err)}
    };
    $('#cards').addEventListener('click',e=>{
      const b=e.target.closest('[data-vote]');if(b){vote(b.closest('.card').dataset.id,b.dataset.vote);return}
      const d=e.target.closest('[data-detail]');if(d){detail(d.dataset.detail);return}
    });
    $('#detail-close').onclick=()=>$('#detail-dialog').close();
    $('#share-close').onclick=()=>$('#share-dialog').close();
    $('#open-share').onclick=()=>{
      $('#room-code').textContent=state.room||'尚未加入房間';
      $('#share-status').textContent=cloud?'雲端已啟用。兩支手機使用同一房間連結，選不同星星角色；資料約4.5秒更新一次。':'目前仍是本機模式。分享網址可轉送，但不同手機的勾選不會同步；請先完成Supabase雲端設定。';
      $('#share-dialog').showModal();
    };
    $('#copy-link').onclick=async()=>{
      try{await navigator.clipboard.writeText(roomUrl());toast('共用網址已複製')}catch{toast('無法自動複製，請複製網址列連結')}
      if(!cloud)$('#share-status').textContent='尚未設定雲端同步，因此夥伴無法看到你本機的勾選；請先設定資料庫。';
    };
    $('#export-list').onclick=createDownload;
    $('#change-role').onclick=()=>{
      $('#share-dialog').close();if(state.poll)clearInterval(state.poll);state.poll=null;
      localStorage.removeItem(currentRoleKey(state.room));state.role=null;showJoin();$('#join-code').value=state.room;
    };
    $('#join-dialog').querySelectorAll('[data-role]').forEach(el=>el.onclick=()=>{
      $('#join-dialog').dataset.role=el.dataset.role;
      $('#join-dialog').querySelectorAll('[data-role]').forEach(e=>e.classList.toggle('selected',e===el));
      $('#join-start').disabled=false;
    });
    $('#join-start').onclick=async()=>{
      const role=$('#join-dialog').dataset.role, room=$('#join-code').value.trim();
      if(!role)return;
      $('#join-start').disabled=true;$('#join-start').textContent='正在準備餐桌…';
      try{await startRoom(role,room)}catch(e){$('#join-alert').textContent=e.message;$('#join-alert').hidden=false}
      $('#join-start').textContent='建立／加入兩人的餐桌';$('#join-start').disabled=false;
    };
  }
  function bootstrap(){
    bind(); render();
    const param=new URLSearchParams(location.search).get('room');
    const room=param||localStorage.getItem('birthday-dining:last-room');
    if(room)$('#join-code').value=room;
    if(room && localStorage.getItem(currentRoleKey(room))) {
      startRoom(localStorage.getItem(currentRoleKey(room)),room).catch(e=>{console.error(e);showJoin()});
    } else showJoin();
    setSyncStatus(cloud?'等待雲端連線':'僅本機・未同步',false);
  }
  document.addEventListener('DOMContentLoaded',bootstrap);
})();
