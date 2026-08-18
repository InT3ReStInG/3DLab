const json=(body,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"no-store"}});

async function ensureTable(db){
  await db.prepare("CREATE TABLE IF NOT EXISTS lab_state (id INTEGER PRIMARY KEY, printers TEXT NOT NULL, activity TEXT NOT NULL, updated_at INTEGER NOT NULL)").run();
  const found=await db.prepare("SELECT id FROM lab_state WHERE id=1").first();
  if(found)return;
  const now=Date.now();
  const printers=[
    {id:"printer-01",name:"Yazıcı 01",color:"#dc2626",status:"printing",job:"İHA sensör braketi v4",owner:"Ece Yılmaz",endsAt:now+8280000,queue:[{id:"q1",name:"Hava girişi prototipi",owner:"Kerem",duration:150}]},
    {id:"printer-02",name:"Yazıcı 02",color:"#2563eb",status:"free",queue:[]},
    {id:"printer-03",name:"Yazıcı 03",color:"#64748b",status:"finished",job:"Kanat nervürü test parçası",owner:"Mert Kaya",endsAt:now-1440000,queue:[]},
    {id:"printer-04",name:"Yazıcı 04",color:"#64748b",status:"maintenance",maintenanceNote:"Nozul değişimi",queue:[]},
    {id:"printer-05",name:"Yazıcı 05",color:"#2563eb",status:"free",queue:[{id:"q2",name:"Motor bağlantı parçası",owner:"Selin",duration:95}]}
  ];
  const activity=[
    {id:"a1",action:"Baskı başlatıldı",detail:"İHA sensör braketi v4 · Yazıcı 01",user:"Ece Yılmaz",at:now-2820000},
    {id:"a2",action:"Baskı tamamlandı",detail:"Kanat nervürü test parçası · Yazıcı 03",user:"Mert Kaya",at:now-4920000},
    {id:"a3",action:"Bakım modu açıldı",detail:"Nozul değişimi · Yazıcı 04",user:"Laboratuvar Sorumlusu",at:now-11520000}
  ];
  await db.prepare("INSERT INTO lab_state (id,printers,activity,updated_at) VALUES (1,?,?,?)").bind(JSON.stringify(printers),JSON.stringify(activity),now).run();
}

async function readState(db){
  await ensureTable(db);
  const row=await db.prepare("SELECT printers,activity FROM lab_state WHERE id=1").first();
  const state={printers:JSON.parse(row.printers),activity:JSON.parse(row.activity)};
  let changed=false;
  state.printers=state.printers.map(p=>{if(p.status==="printing"&&p.endsAt&&p.endsAt<=Date.now()){changed=true;return{...p,status:"finished"}}return p});
  if(changed)await writeState(db,state);
  return state;
}

async function writeState(db,state){
  await db.prepare("UPDATE lab_state SET printers=?,activity=?,updated_at=? WHERE id=1").bind(JSON.stringify(state.printers),JSON.stringify(state.activity.slice(0,500)),Date.now()).run();
}

export async function onRequestGet({env}){
  if(!env.DB)return json({error:"D1 veritabanı bağlantısı eksik. Cloudflare Pages ayarlarından DB bağlantısını ekleyip yeniden yayınlayın."},500);
  try{return json(await readState(env.DB))}catch(error){return json({error:error.message||"Veritabanı hatası"},500)}
}

export async function onRequestPost({request,env}){
  if(!env.DB)return json({error:"D1 veritabanı bağlantısı eksik. Cloudflare Pages ayarlarından DB bağlantısını ekleyip yeniden yayınlayın."},500);
  try{
    const state=await readState(env.DB),body=await request.json();
    if(!body.entry?.user?.trim())return json({error:"Adınızı girmeniz gerekiyor"},400);
    if(body.action==="updatePrinter"&&body.printer)state.printers=state.printers.map(p=>p.id===body.printer.id?body.printer:p);
    else if(body.action==="addPrinter"&&body.printer&&!state.printers.some(p=>p.id===body.printer.id))state.printers.push(body.printer);
    else if(body.action==="deletePrinter"&&body.printerId)state.printers=state.printers.filter(p=>p.id!==body.printerId);
    else if(body.action!=="activity")return json({error:"Geçersiz işlem"},400);
    state.activity.unshift(body.entry);
    await writeState(env.DB,state);
    return json({ok:true});
  }catch(error){return json({error:error.message||"Veritabanı hatası"},500)}
}
