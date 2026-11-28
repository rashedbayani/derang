import categories from "./questions.json" with { type: "json" };

const url = Deno.env.get("SUPABASE_URL")!;
const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
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
  const response = await fetch(url+"/rest/v1/rpc/derang_group_request", {
    method:"POST", headers:{apikey:secret,Authorization:"Bearer "+secret,"Content-Type":"application/json"},
    body:JSON.stringify({action,credential,payload})
  });
  if (!response.ok) {
    console.error("Derang database request failed", action, response.status);
    throw new Error("Database request failed");
  }
  return response.json();
}

const analysisVersion = "persian-v1";
const openAIKey = Deno.env.get("OPENAI_API_KEY");
function analysisInput(report: { totals: Record<string, {score:number;count:number}> }) {
  return categories.flatMap(c => c.items.flatMap(q => {
    const total = report.totals[q.id];
    return total ? [{ category:c.title, question:q.prompt.replaceAll("{نام}","این فرد"),
      scale:q.scale, score:total.score, responses:total.count }] : [];
  }));
}
async function analysisCache(operation:string,credential:string,lease:string|null=null,summary:string|null=null) {
  const response = await fetch(url+"/rest/v1/rpc/derang_report_analysis", {
    method:"POST",headers:{apikey:secret,Authorization:"Bearer "+secret,"Content-Type":"application/json"},
    body:JSON.stringify({operation,credential,analysis_version:analysisVersion,request_lease:lease,analysis_text:summary})
  });
  if (!response.ok) throw new Error("Analysis cache request failed");
  return response.json();
}
async function analyze(credential:string, report: { totals: Record<string,{score:number;count:number}> }) {
  if (!openAIKey) return reject("تحلیل هوش مصنوعی هنوز فعال نشده است.",503);
  const input = analysisInput(report);
  if (input.length < 2) return reject("برای تحلیل، نتیجهٔ قابل‌نمایش دست‌کم دو سؤال لازم است.",409);
  const lease = crypto.randomUUID();
  const cached = await analysisCache("claim",credential,lease);
  if (cached.summary) return send({summary:cached.summary});
  if (!cached.claimed) return reject("تحلیل هنوز آماده نیست. کمی بعد دوباره امتحان کن.",409);
  try {
    const result = await fetch("https://api.openai.com/v1/responses", {
      method:"POST",headers:{Authorization:"Bearer "+openAIKey,"Content-Type":"application/json"},
      signal:AbortSignal.timeout(25000),
      body:JSON.stringify({model:"gpt-4.1-mini",store:false,max_output_tokens:500,
        instructions:"یک جمع‌بندی حرفه‌ای و کوتاه به فارسی روان، در دو یا سه بند و حداکثر ۱۱۰ کلمه بنویس. فقط به داده‌های داده‌شده تکیه کن. نمره‌ها از پنج و مربوط به برداشت دوستان هستند. اگر داده اجازه می‌دهد، یک نقطه قوت و یک فرصت بهبود با یک گام عملی کوچک ذکر کن. تعداد کم پاسخ‌ها را در تفسیر لحاظ کن. تشخیص، برچسب شخصیتی، حدس دربارهٔ هویت یا عقاید سیاسی، رتبه‌بندی گروهی، نتیجه‌گیری قطعی و قالب مارک‌داون ممنوع است. اگر اختلاف معنی‌داری دیده نمی‌شود آن را بیان کن و تفاوت ساختگی نساز.",
        input:JSON.stringify(input)})
    });
    if (!result.ok) {
      console.error("OpenAI summary failed",result.status);
      return reject("تحلیل آماده نشد. حدود یک دقیقه دیگر دوباره امتحان کن.",502);
    }
    const data = await result.json();
    const summary = (data.output ?? []).flatMap((item: {type:string;content?:{type:string;text?:string}[]}) =>
      item.type === "message" ? (item.content ?? []).filter(part => part.type === "output_text").map(part => part.text ?? "") : []
    ).join("\n").trim();
    if (data.status !== "completed" || !summary || summary.length > 1600) {
      return reject("تحلیل کامل دریافت نشد. حدود یک دقیقه دیگر دوباره امتحان کن.",502);
    }
    const saved = await analysisCache("complete",credential,lease,summary);
    if (!saved.saved) return reject("تحلیل هنوز آماده نیست. کمی بعد دوباره امتحان کن.",409);
    return send({summary});
  } catch {
    return reject("تحلیل آماده نشد. حدود یک دقیقه دیگر دوباره امتحان کن.",502);
  }
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
  const path = pathname.replace(/^\/(?:functions\/v1\/)?derang-v2(?=\/|$)/,"");
  const post = req.method === "POST";
  const get = req.method === "GET";
  const token = req.headers.get("authorization")?.match(/^Bearer (.{1,4096})$/i)?.[1] ?? "";
  try {
    if (get && path === "/health") return send(await rpc("health"));
    const body = post ? await readBody(req) : {};
    if (!body) return reject("فرمت درخواست معتبر نیست.",400);
    if (get && path === "/categories") return send(extras.map(({id,title}) => ({id,title})));
    if (post && path === "/groups") {
      const name = clean(body.name,80);
      const selected = extras.filter(c => Array.isArray(body.categories) && body.categories.includes(c.id)).map(c => c.id);
      if (!name || !Number.isSafeInteger(body.deadline) || body.deadline <= Date.now() || selected.length > 3) {
        return reject("نام گروه، مهلت و دسته‌ها را بررسی کن.",400);
      }
      const groupKey = random(12).toUpperCase();
      const ownerKey = random(16).toUpperCase();
      const ownerToken = random(32);
      const result = await rpc("new_group",await hash(ownerToken),{name,deadline:body.deadline,categories:[...core,...selected],
        groupHash:await hash(groupKey),ownerHash:await hash(ownerKey)});
      return result.status ? reject(result.message,result.status) : send({groupKey,ownerKey,token:ownerToken});
    }
    if (post && ["/access/member","/access/owner"].includes(path)) {
      const owner = path.endsWith("/owner");
      const normalize = (value: unknown) => clean(value,80).toUpperCase().replace(/[\s-]/g,"");
      const groupKey = normalize(body.groupKey);
      const key = normalize(body.key);
      if (!/^[0-9A-F]{24}$/.test(groupKey) || !/^[0-9A-F]{32}$/.test(key)) {
        return reject("کلیدهای واردشده معتبر نیستند.",401);
      }
      const freshToken = random(32);
      const result = await rpc(owner ? "owner_login" : "member_login",await hash(freshToken),
        {groupHash:await hash(groupKey),keyHash:await hash(key)});
      return result.status ? reject(result.message,result.status) : send({token:freshToken});
    }
    if (post && path === "/register") {
      const groupKey = clean(body.groupKey,24).toUpperCase();
      const invite = clean(body.invite,48).toLowerCase();
      const key = clean(body.key,32).toUpperCase();
      const name = clean(body.name,80);
      if (!/^[0-9A-F]{24}$/.test(groupKey) || !/^[0-9a-f]{48}$/.test(invite) || !/^[0-9A-F]{32}$/.test(key) || !name) {
        return reject("نام یا لینک دعوت معتبر نیست.",400);
      }
      const result = await rpc("register","",{groupHash:await hash(groupKey),inviteHash:await hash(invite),codeHash:await hash(key),name});
      return result.status ? reject(result.message,result.status) : send({});
    }
    if (!/^[a-f0-9]{64}$/.test(token)) return reject("دوباره وارد شو.",401);
    const credential = await hash(token);
    if (get && path === "/manage") {
      const result = await rpc("manage",credential);
      return result.status ? reject(result.message,result.status) : send(result);
    }
    if (post && path === "/manage/close") {
      const result = await rpc("close_group",credential);
      return result.status ? reject(result.message,result.status) : send(result);
    }
    if (post && path === "/manage/invites") {
      const invite = random(24);
      const result = await rpc("new_invite",credential,{inviteHash:await hash(invite)});
      return result.status ? reject(result.message,result.status) : send({invite});
    }
    const approval = post ? path.match(/^\/manage\/members\/([a-f0-9-]+)\/approve$/) : null;
    if (approval) {
      const result = await rpc("approve_member",credential,{id:approval[1]});
      return result.status ? reject(result.message,result.status) : send(result);
    }
    const review = path.match(/^\/review\/([\w-]+)$/);
    let result;
    if (get && path === "/group") result = await rpc("group",credential);
    else if (post && path === "/logout") result = await rpc("logout",credential);
    else if (post && path === "/consent") result = await rpc("consent",credential,
      {options:allowedConsent.filter(c => Array.isArray(body.options) && body.options.includes(c))});
    else if ((get && path === "/report") || (post && path === "/report/analysis")) result = await rpc("report",credential);
    else if (review && get) result = await rpc("review_form",credential,{id:review[1]});
    else if (review && post) {
      const answers = body.answers ?? {};
      if (typeof answers !== "object" || Array.isArray(answers)) return reject("پاسخ نامعتبر است.",400);
      result = await rpc("review_submit",credential,{id:review[1],answers,questionIds,
        appreciation:clean(body.appreciation,400),change:clean(body.change,400)});
    } else return reject("صفحه پیدا نشد.",404);
    if (result.status) return reject(result.message,result.status);
    if (post && path === "/report/analysis") return await analyze(credential,result);
    if (result.categories && result.consent) {
      const selected = categories.filter(c => result.categories.includes(c.id) || (["style","politics"].includes(c.id) && result.consent.includes(c.id)));
      if (path === "/report") {
        const cached = await analysisCache("get",credential).catch(() => null);
        return send({name:result.name,analysis:cached?.summary ?? null,
          analysisAvailable:!!openAIKey && analysisInput(result).length >= 2,
        report:selected.map(c => ({...c,items:c.items.map(q => ({...q,...(result.totals[q.id] ?? {score:null,count:null})}))})),
        comments:{appreciation:[],change:[],...result.comments}});
      }
      return send({name:result.name,categories:selected,text:result.consent.includes("text")});
    }
    return send(result);
  } catch {
    return reject("خطایی رخ داد. دوباره تلاش کن.",500);
  }
});
