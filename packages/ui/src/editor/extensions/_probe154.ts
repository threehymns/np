import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
const md = markdown({ extensions:[GFM] as any });
function k(doc:string){ const s=EditorState.create({doc,extensions:[md]}); const out=[]; syntaxTree(s).iterate({enter:(n:any)=>{ if(/Blockquote|Paragraph/i.test(n.name)) out.push(n.name+":"+JSON.stringify(s.doc.sliceString(n.from,n.to))}}); \n; }); } catch(e){} }
