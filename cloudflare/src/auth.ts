import { bad, HttpError, text } from "./domain";
const encoder=new TextEncoder();
export function randomToken(bytes=32):string {return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b=>b.toString(16).padStart(2,"0")).join("");}
export async function hash(value:string):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(value)))].map(b=>b.toString(16).padStart(2,"0")).join("");}
export function equal(left:string,right:string):boolean {let diff=left.length^right.length;for(let i=0;i<Math.max(left.length,right.length);i++)diff|=(left.charCodeAt(i)||0)^(right.charCodeAt(i)||0);return diff===0;}
async function derive(password:string,salt:Uint8Array):Promise<string>{
 const key=await crypto.subtle.importKey("raw",encoder.encode(password),"PBKDF2",false,["deriveBits"]);
 return [...new Uint8Array(await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt,iterations:100000},key,256))].map(b=>b.toString(16).padStart(2,"0")).join("");
}
export async function passwordHash(password:string):Promise<string>{const salt=crypto.getRandomValues(new Uint8Array(16));return `pbkdf2-sha256:100000:${[...salt].map(b=>b.toString(16).padStart(2,"0")).join("")}:${await derive(password,salt)}`;}
export async function verifyPassword(password:string,stored:string):Promise<boolean>{
 const parts=stored.split(":");if(parts.length!==4||parts[0]!=="pbkdf2-sha256"||parts[1]!=="100000"||!/^[0-9a-f]{32}$/.test(parts[2])||!/^[0-9a-f]{64}$/.test(parts[3]))return false;
 return equal(await derive(password,new Uint8Array(parts[2].match(/../g)!.map(v=>parseInt(v,16)))),parts[3]);
}
export function credentials(input:Record<string,unknown>){
 const username=text(input.username).trim(),password=text(input.password),bytes=encoder.encode(password).length;
 if(!username||[...username].length>32||bytes<8||bytes>72)bad("昵称需要 1–32 个字，密码需要 8–72 个字节");return {username,password};
}
export async function input(request:Request,allowed:string[]):Promise<Record<string,unknown>>{
 if(request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase()!=="application/json")throw new HttpError(415,"请使用 JSON 提交数据");
 const reader=request.body?.getReader();if(!reader)bad("提交的数据格式不正确");let size=0;const chunks:Uint8Array[]=[];
 for(;;){const {value,done}=await reader!.read();if(done)break;size+=value!.byteLength;if(size>16384){await reader!.cancel();throw new HttpError(413,"提交的数据过大");}chunks.push(value!);}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 let body:unknown;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{bad("提交的数据格式不正确");}
 if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(key=>!allowed.includes(key)))bad("提交的数据格式不正确");return body as Record<string,unknown>;
}
export function cookieToken(request:Request):string {return request.headers.get("Cookie")?.split(";").map(v=>v.trim()).find(v=>v.startsWith("four_plans_session="))?.slice("four_plans_session=".length)||"";}
export function sessionCookie(token:string,request:Request,remove=false):string{return `four_plans_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${remove?0:2592000}${new URL(request.url).protocol==="https:"?"; Secure":""}`;}
