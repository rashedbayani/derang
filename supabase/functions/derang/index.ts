import categories from "./questions.json" with { type: "json" };

const url = Deno.env.get("SUPABASE_URL")!;
const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
const origin = "https://rashedbayani.github.io";
const core = categories.slice(0,5).map(c => c.id);
const extras = categories.filter(c => ![...core,"style","politics"].includes(c.id));
const allowedConsent = ["style","politics","text"];
const questionIds = Object.fromEntries(categories.map(c => [c.id,c.items.map(q => q.id)]));
const clean = (v: unknown,n: number) => typeof v === "string" ? v.trim().slice(0,n) : "";
const hex = (bytes: Uint8Array) => [...bytes].map(n => n.toString(16).padStart(2,"0")).join("");
const random = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)));
const hash = async (v: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));
const headers = {"Content-Type":"application/json","Cache-Control":"no-store","Access-Control-Allow-Origin":origin,
  "Access-Control-Allow-Headers":"Content-Type, Authorization","Access-Control-Allow-Methods":"GET, POST, OPTIONS","Vary":"Origin"};
const send = (data: unknown,status=200) => new Response(JSON.stringify(data),{status,headers});
const reject = (message:string,status:number) => send({message},status);

async function rpc(action:string,credential="",payload:object={}) {
  const response = await fetch(url+"/rest/v1/rpc/derang_request", {
    method:"POST", headers:{apikey:secret,Authorization:"Bearer "+secret,"Content-Type":"application/json"},
    body:JSON.stringify({action,credential,payload})
  });
  if (!response.ok) {
    console.error("Derang database request failed", action, response.status);
    throw new Error("Database request failed");
  }
  return response.json();
}

async function auth(path:string,token="",password?:{email:string;password:string}) {
  return fetch(url+"/auth/v1/"+path, {method:password || path==="logout" ? "POST" : "GET",
    headers:{apikey:anon,"Content-Type":"application/json",...(token ? {Authorization:"Bearer "+token} : {})},
    body:password ? JSON.stringify(password) : undefined});
}

async function readBody(req: Request) {
  const reader = req.body?.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  if (!reader) return null;
  while (true) {
    const {value,done} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 32768) { await reader.cancel(); return null; }
    text += decoder.decode(value,{stream:true});
  }
  try {
    const body = JSON.parse(text + decoder.decode());
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch { return null; }
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response(null,{status:204,headers});
  const pathname = new URL(req.url).pathname;
  const path = pathname.replace(/^\/(?:functions\/v1\/)?derang(?=\/|$)/,"");
  const post = req.method === "POST";
  const get = req.method === "GET";
  const token = req.headers.get("authorization")?.match(/^Bearer (.{1,4096})$/i)?.[1] ?? "";
  try {
    if (get && path === "/health") return send(await rpc("health"));
    const body = post ? await readBody(req) : {};
    if (!body) return reject("فرمت درخواست معتبر نیست.",400);
    if (post && path === "/access/member") {
      const code = clean(body.code,64).toUpperCase().replace(/[\s-]/g,"");
      if (!/^[0-9A-F]{32}$/.test(code)) return reject("کد دعوت معتبر نیست.",401);
      const memberToken = random(32);
      const result = await rpc("member_login",await hash(memberToken),{codeHash:await hash(code)});
      return result.status ? reject(result.message,result.status) : send({token:memberToken,role:"member"});
    }
    if (post && path === "/access/admin") {
      const email = clean(body.email,254);
      const password = typeof body.password === "string" ? body.password.slice(0,256) : "";
      const response = await auth("token?grant_type=password","",{email,password});
      if (response.status === 429) return reject("کمی صبر کن و دوباره تلاش کن.",429);
      if (!response.ok) return reject("ایمیل یا رمز عبور درست نیست.",401);
      const session = await response.json();
      const result = await rpc("admin",session.user.id);
      return result.status ? reject(result.message,result.status) : send({token:session.access_token,role:"admin"});
    }
    if (!token) return reject("دوباره وارد شو.",401);
    const adminPath = (get && path === "/admin") || (post && path === "/groups");
    const groupPath = post ? path.match(/^\/groups\/([\w-]+)\/(members|close)$/) : null;
    const memberToken = /^[a-f0-9]{64}$/.test(token);
    if (adminPath || groupPath || (post && path === "/logout" && !memberToken)) {
      const profile = await auth("user",token);
      if (!profile.ok) return reject("دوباره وارد شو.",401);
      const adminId = (await profile.json()).id;
      if (path === "/logout") {
        const response = await auth("logout",token);
        return response.ok ? send({}) : reject("خروج از حساب انجام نشد.",502);
      }
      let result;
      if (get) {
        result = await rpc("admin",adminId);
        if (!result.status) result.categories = extras.map(({id,title}) => ({id,title}));
      } else if (path === "/groups") {
        const name = clean(body.name,80);
        const selected = extras.filter(c => Array.isArray(body.categories) && body.categories.includes(c.id)).map(c => c.id);
        if (!name || !Number.isSafeInteger(body.deadline) || body.deadline <= Date.now() || selected.length > 3) return reject("نام گروه، مهلت و دسته‌ها را بررسی کن.",400);
        result = await rpc("new_group",adminId,{name,deadline:body.deadline,categories:[...core,...selected]});
      } else if (groupPath?.[2] === "close") {
        result = await rpc("close_group",adminId,{id:groupPath[1]});
      } else {
        const name = clean(body.name,80);
        if (!name) return reject("نام عضو را وارد کن.",400);
        const code = random(16).toUpperCase();
        result = await rpc("new_member",adminId,{id:groupPath?.[1],name,codeHash:await hash(code)});
        if (!result.status) result.code = code;
      }
      return result.status ? reject(result.message,result.status) : send(result);
    }
    if (!memberToken) return reject("این بخش برای اعضاست.",404);
    const credential = await hash(token);
    const review = path.match(/^\/review\/([\w-]+)$/);
    let result;
    if (get && path === "/group") result = await rpc("group",credential);
    else if (post && path === "/logout") result = await rpc("logout",credential);
    else if (post && path === "/consent") result = await rpc("consent",credential,
      {options:allowedConsent.filter(c => Array.isArray(body.options) && body.options.includes(c))});
    else if (get && path === "/report") result = await rpc("report",credential);
    else if (review && get) result = await rpc("review_form",credential,{id:review[1]});
    else if (review && post) {
      const answers = body.answers ?? {};
      if (typeof answers !== "object" || Array.isArray(answers)) return reject("پاسخ نامعتبر است.",400);
      result = await rpc("review_submit",credential,{id:review[1],answers,questionIds,
        appreciation:clean(body.appreciation,400),change:clean(body.change,400)});
    } else return reject("صفحه پیدا نشد.",404);
    if (result.status) return reject(result.message,result.status);
    if (result.categories && result.consent) {
      const selected = categories.filter(c => result.categories.includes(c.id) || (["style","politics"].includes(c.id) && result.consent.includes(c.id)));
      if (path === "/report") return send({name:result.name,
        report:selected.map(c => ({...c,items:c.items.map(q => ({...q,...(result.totals[q.id] ?? {score:null,count:null})}))})),
        comments:{appreciation:[],change:[],...result.comments}});
      return send({name:result.name,categories:selected,text:result.consent.includes("text")});
    }
    return send(result);
  } catch {
    return reject("خطایی رخ داد. دوباره تلاش کن.",500);
  }
});
