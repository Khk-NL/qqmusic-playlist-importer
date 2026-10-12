const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../qqmusic_playlist_import.user.js'), 'utf8');
const exposed = ['parseCsv','planSongs','chooseCandidate','cleanCandidateTitle','dedupeCandidates','saveJob','loadJob','clearJob','assertActive','findPlaylistRowByName','findPlaylistChoiceInMenu','runAutomation','processCurrentSong','addCandidateToPlaylist'];

function harness() {
  const storage = new Map();
  const context = { console, Date, URLSearchParams, setTimeout, clearTimeout,
    localStorage: {getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    navigator:{locks:{request:async (_name, _options, callback)=>callback({})}},
    document:{querySelector:()=>null,querySelectorAll:()=>[]},
    location:{pathname:'/n/ryqq_v2/search',search:'?w=Radiant%20MSR'},
  };
  vm.createContext(context);
  vm.runInContext(source.slice(0,source.indexOf('  if (document.readyState'))+`
    renderPanel = () => {};
    isLoggedIn = () => true;
    globalThis.audit = {${exposed.join(',')}, runtime,
      replaceProcess: fn => {processCurrentSong = fn;},
      searchCandidates: candidates => {
        waitFor = async fn => fn(); findSearchRows = () => candidates;
        extractCandidate = row => row; addCandidateToPlaylist = async () => {throw new Error('network failure');};
      },
      setupBulk: (click, menus, choice, tip) => {
        clickElement = click; waitFor = async fn => fn();
        getVisibleOperateMenus = menus; findPlaylistChoiceInMenu = choice; getPopupTipText = tip;
      }
    };
  })();`,context);
  return {a:context.audit, context};
}
function candidate(overrides={}) {
  return {title:'Radiant',artists:['MSR'],album:'Radiant',mid:'001uwAoL3UzXbg',isLikelyMv:false,addButton:{},row:{},...overrides};
}
test('歌名以 Sq 开头时不被误当作音质标记',()=>{
  const {a}=harness();
  assert.equal(a.cleanCandidateTitle('Squad Unknown'),'squad unknown');
  assert.equal(a.cleanCandidateTitle('SQ Radiant'),'radiant');
});
function job(overrides={}) {
  return {id:'task-1',status:'running',stopRequested:false,preview:true,playlistEnsured:true,currentIndex:0,
    playlistName:'明日方舟 EP 与人声曲',songs:[{song:'Radiant',artist:'MSR',status:'pending'}],logs:[],...overrides};
}
test('不接受同名错误歌手和歌手子串',()=>{
  const {a}=harness();
  for (const artist of ['Someone Else','MSR Cover','翻唱MSR','MSR官方']) assert.equal(a.chooseCandidate([candidate({artists:[artist]})],'Radiant','MSR').type,'not_found');
});
test('允许官方合作歌手，要求所有指定歌手均在候选中',()=>{
  const {a}=harness();
  assert.equal(a.chooseCandidate([candidate({artists:['MSR','Mary Clare']})],'Radiant','MSR').type,'selected');
  assert.equal(a.chooseCandidate([candidate()],'Radiant','MSR/Mary Clare').type,'not_found');
});
test('Live、Instrumental 版本须明确允许且名称完全一致',()=>{
  const {a}=harness();
  for (const suffix of ['Live','Instrumental']) {
    const title=`Radiant (${suffix})`;
    assert.equal(a.chooseCandidate([candidate({title})],'Radiant','MSR').type,'not_found');
    assert.equal(a.chooseCandidate([candidate({title})],title,'MSR').type,'not_found');
    assert.equal(a.chooseCandidate([candidate({title})],title,'MSR',{allowVariant:true}).type,'selected');
  }
});
test('专辑现场标记也会排除，但 Alive 不被误识别为 Live',()=>{
  const {a}=harness();
  assert.equal(a.chooseCandidate([candidate({album:'2025现场'})],'Radiant','MSR').type,'not_found');
  assert.equal(a.chooseCandidate([candidate({title:'ALIVE',album:'ALIVE'})],'Alive','MSR').type,'selected');
});
test('不同录音不按歌名折叠，可用 mid/album 消除歧义',()=>{
  const {a}=harness();
  const rows=[candidate(),candidate({mid:'003UOvfC1Zlf4H',album:'Reissue'})];
  assert.equal(a.chooseCandidate(rows,'Radiant','MSR').type,'ambiguous');
  assert.equal(a.chooseCandidate(rows,'Radiant','MSR',{mid:'001uwAoL3UzXbg'}).candidate.mid,'001uwAoL3UzXbg');
  assert.equal(a.chooseCandidate(rows,'Radiant','MSR',{album:'Reissue'}).candidate.mid,'003UOvfC1Zlf4H');
  assert.equal(a.dedupeCandidates([rows[0],rows[0]]).length,1);
});
test('CSV 支持 BOM、引号、逗号和可选元数据；同名只保留首条',()=>{
  const {a}=harness();
  const parsed=a.parseCsv('\ufeffsong,artist,date,mid,album,allow_variant\r\n"Song, Name",MSR,2024-02-29,001uwAoL3UzXbg,Album,true\r\n"Song, Name",Other,,,,\r\n');
  assert.equal(parsed.duplicateCount,1);
  assert.equal(parsed.songs[0].song,'Song, Name');
  assert.equal(parsed.songs[0].allowVariant,true);
});
test('CSV 缺列、缺歌手、非法日期、非法 mid 和未闭合引号均报错',()=>{
  const {a}=harness();
  for (const csv of ['song\nA','song,artist\nA,','song,artist,date\nA,MSR,2024-02-30','song,artist,mid\nA,MSR,bad','song,artist\n"A,MSR']) assert.throws(()=>a.parseCsv(csv));
});
test('发行日期从新到旧：顶部插入时倒序执行；末尾插入时正序执行',()=>{
  const {a}=harness();
  const songs=[{song:'Old',date:'2020-01-01'},{song:'New',date:'2025-01-01'},{song:'Same',date:'2025-01-01'}];
  assert.deepEqual(Array.from(a.planSongs(songs,'date-desc','head'),s=>s.song),['Old','Same','New']);
  assert.deepEqual(Array.from(a.planSongs(songs,'date-desc','tail'),s=>s.song),['New','Same','Old']);
  assert.equal(songs[0].desiredIndex,undefined);
  assert.throws(()=>a.planSongs([{song:'Missing'}],'date-desc'));
});
test('歌单只能精确匹配，重复名称会报错',()=>{
  const {a,context}=harness();
  const rows=['明日方舟 EP 与人声曲备份','明日方舟 EP 与人声曲'].map(title=>({title,querySelector:()=>({textContent:title})}));
  context.document.querySelectorAll=()=>rows;
  assert.equal(a.findPlaylistRowByName('明日方舟 EP 与人声曲').title,rows[1].title);
  context.document.querySelectorAll=()=>[rows[1],rows[1]];
  assert.throws(()=>a.findPlaylistRowByName('明日方舟 EP 与人声曲'));
});
test('异步步骤保存不能覆盖停止请求',async()=>{
  const {a}=harness(); let enter,release;
  const entered=new Promise(r=>enter=r),pending=new Promise(r=>release=r);
  a.saveJob(job({songs:[{},{}]}),true);
  a.replaceProcess(async j=>{enter();await pending;j.currentIndex++;});
  const running=a.runAutomation();await entered;
  const stop=a.loadJob();stop.stopRequested=true;a.saveJob(stop);
  release();await running;
  assert.equal(a.loadJob().stopRequested,true);
  assert.equal(a.loadJob().status,'stopped');
});
test('清除或替换任务后，旧步骤不能恢复或覆盖任务',()=>{
  const {a}=harness();const old=job();a.saveJob(old,true);
  a.clearJob();assert.equal(a.saveJob(old),false);assert.equal(a.loadJob(),null);
  a.saveJob(job({id:'task-2'}),true);assert.equal(a.saveJob(old),false);assert.equal(a.loadJob().id,'task-2');
  a.runtime.activeJobId='task-1';assert.throws(()=>a.assertActive());
});
test('没有拿到跨标签页锁时，不执行任务',async()=>{
  const {a,context}=harness();a.saveJob(job(),true);
  context.navigator.locks.request=async(_name,_options,callback)=>callback(null);
  let executed=false;a.replaceProcess(async()=>{executed=true;});await a.runAutomation();assert.equal(executed,false);
});
test('预检只记录候选，不调用写入',async()=>{
  const {a}=harness();a.searchCandidates([candidate()]);const j=job();a.saveJob(j,true);
  await a.processCurrentSong(j);assert.equal(j.songs[0].status,'matched');assert.equal(j.songs[0].matched.mid,'001uwAoL3UzXbg');
});
test('写入失败保留歌曲及错误信息；游标和执行顺序不会重新反转',async()=>{
  const {a}=harness();a.searchCandidates([candidate()]);const j=job({preview:false});a.saveJob(j,true);
  await a.processCurrentSong(j);a.saveJob(j);
  assert.equal(a.loadJob().songs[0].status,'failed');assert.equal(a.loadJob().songs[0].detail,'network failure');
  assert.equal(a.loadJob().songs[0].song,'Radiant');assert.equal(a.loadJob().currentIndex,1);
});
test('批量写入只选一首，等待本次提示；菜单关闭不能当作成功',async()=>{
  for (const showSuccess of [true,false]) {
    const {a,context}=harness();let observe,tip='';
    const boxes=[{checked:false},{checked:true}];
    const selectedRow={contains:b=>b===boxes[0],querySelector:()=>({getAttribute:()=>'/n/ryqq_v2/songDetail/001uwAoL3UzXbg',isConnected:true,closest:()=>null,getBoundingClientRect:()=>({width:10,height:10})})};
    context.window={getComputedStyle:()=>({})};
    const add={kind:'add'},choice={kind:'choice'},menu={id:'fav_pop'};
    context.document={body:{},querySelector:s=>s.includes("input[type=")?boxes[0]:{closest:()=>add},querySelectorAll:s=>s==='.songlist__item'?[selectedRow]:boxes};
    context.MutationObserver=class{constructor(callback){observe=callback;}observe(){}disconnect(){}};
    const click=async node=>{
      if(boxes.includes(node)) node.checked=!node.checked;
      if(node===choice&&showSuccess){tip='添加成功';observe([{target:{nodeType:1,closest:()=>true},addedNodes:[]}]);}
    };
    a.setupBulk(click,()=>[menu],()=>choice,()=>tip);
    if(showSuccess) assert.equal(await a.addCandidateToPlaylist(candidate(),'Target'),'added');
    else await assert.rejects(()=>a.addCandidateToPlaylist(candidate(),'Target'),/未检测到/);
    assert.equal(boxes[0].checked,true);assert.equal(boxes[1].checked,false);
  }
});
