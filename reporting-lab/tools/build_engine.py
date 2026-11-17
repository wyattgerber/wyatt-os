"""Builds nts_is_cpm_engine.js from nts_is_cpm_page.html.

The engine is the page's own script, run without a browser: the same calculations, the same Excel and PDF builders. Only the
edges change: the data calls become direct server calls, the page's controls become inert stand-ins, and async/await is
removed so it runs start to finish in a Scheduled Script. Rebuild it whenever the page changes."""
import re, sys

src = open(sys.argv[1] if len(sys.argv) > 1 else '/home/claude/work/page.html', encoding='utf-8').read()
out_path = sys.argv[2] if len(sys.argv) > 2 else '/mnt/user-data/outputs/suitelet/nts_is_cpm_engine.js'
blocks = [m.group(1) for m in re.finditer(r'<script[^>]*>(.*?)</script>', src, re.S)]
script = max(blocks, key=len)
xlsx_block = '\n'.join(b for b in blocks if b is not script)          # the Excel writer sits in its own block ahead of the page script
t = script

def sub1(a, b):
    global t
    assert t.count(a) == 1, ('anchor', t.count(a), a[:80])
    t = t.replace(a, b)

sub1('const ENDPOINT = "__ENDPOINT__";', 'const ENDPOINT = "NTS";')
t = re.sub(r'\bawait\s+', '', t)          # every await is a plain call: the host answers each request on the spot
t = re.sub(r'\basync\s+', '', t)
sub1("""  function download(blob,name){
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name;
    document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },1000);
  }""", "  function download(blob,name){ HOST.download(blob,name); }")
sub1("  const status = (msg, err) => {", "  const status = (msg, err) => { if(HOST.status) HOST.status(msg, err);")
sub1('(function(){\n  "use strict";', 'var __api=(function(){\n  "use strict";')
sub1("  (function init(){", "  function init(){")
sub1("    } catch(e){ status(e.message,true); $('subtitle').textContent='Could not load'; }\n  })();\n})();",
     "    } catch(e){ status(e.message,true); if(HOST.error) HOST.error(e); }\n  }\n"
     "  return {init:init, applySchedule:applySchedule, exportXlsx:exportXlsx, exportPdf:exportPdf, state:state, isBS:isBS, isLayout:isLayout, isPivot:isPivot, renderAll:renderAll, loadData:loadData, fileName:fileName};\n})();\nreturn __api;")

prelude = r'''
  // ---- the edges of the engine: stand-ins for what a browser provides ----
  var Blob = function(parts, opts){ this.parts = parts || []; this.type = (opts && opts.type) || ''; };
  Blob.prototype.toBytes = function(){
    var chunks = [], n = 0, i, p, b;
    for(i=0;i<this.parts.length;i++){ p=this.parts[i]; b = (typeof p === 'string') ? utf8(p) : (p instanceof Uint8Array ? p : new Uint8Array(p)); chunks.push(b); n += b.length; }
    var out = new Uint8Array(n), o = 0; for(i=0;i<chunks.length;i++){ out.set(chunks[i], o); o += chunks[i].length; } return out;
  };
  function utf8(str){
    var out = [], i, c;
    for(i=0;i<str.length;i++){
      c = str.charCodeAt(i);
      if(c >= 0xD800 && c <= 0xDBFF && i+1 < str.length){ c = 0x10000 + ((c - 0xD800) << 10) + (str.charCodeAt(++i) - 0xDC00); }
      if(c < 0x80) out.push(c);
      else if(c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if(c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }
  var TextEncoder = function(){}; TextEncoder.prototype.encode = utf8;
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function bytesToB64(bytes){
    var s = '', i, a, b, c;
    for(i=0;i<bytes.length;i+=3){
      a = bytes[i]; b = i+1 < bytes.length ? bytes[i+1] : 0; c = i+2 < bytes.length ? bytes[i+2] : 0;
      s += B64.charAt(a >> 2) + B64.charAt(((a & 3) << 4) | (b >> 4)) + (i+1 < bytes.length ? B64.charAt(((b & 15) << 2) | (c >> 6)) : '=') + (i+2 < bytes.length ? B64.charAt(c & 63) : '=');
    }
    return s;
  }
  function b64ToBytes(str){
    str = String(str).replace(/[^A-Za-z0-9+\/]/g, '');
    var out = [], i, a, b, c, d;
    for(i=0;i<str.length;i+=4){
      a = B64.indexOf(str.charAt(i)); b = B64.indexOf(str.charAt(i+1)); c = i+2 < str.length ? B64.indexOf(str.charAt(i+2)) : -1; d = i+3 < str.length ? B64.indexOf(str.charAt(i+3)) : -1;
      out.push((a << 2) | (b >> 4)); if(c >= 0) out.push(((b & 15) << 4) | (c >> 2)); if(d >= 0) out.push(((c & 3) << 6) | d);
    }
    return new Uint8Array(out);
  }
  var btoa = function(bin){ var u = new Uint8Array(bin.length), i; for(i=0;i<bin.length;i++) u[i] = bin.charCodeAt(i) & 255; return bytesToB64(u); };
  var URLSearchParams = function(init){
    this.pairs = [];
    if(typeof init === 'string'){ init.replace(/^\?/, '').split('&').forEach(function(kv){ if(!kv) return; var p = kv.split('='); this.pairs.push([decodeURIComponent(p[0]), decodeURIComponent((p[1] || '').replace(/\+/g, ' '))]); }, this); }
    else if(init){ Object.keys(init).forEach(function(k){ this.pairs.push([k, String(init[k])]); }, this); }
  };
  URLSearchParams.prototype.get = function(k){ for(var i=0;i<this.pairs.length;i++) if(this.pairs[i][0] === k) return this.pairs[i][1]; return null; };
  URLSearchParams.prototype.toString = function(){ return this.pairs.map(function(p){ return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]); }).join('&'); };
  var URL = {createObjectURL: function(){ return ''; }, revokeObjectURL: function(){}};
  var localStorage = (function(){ var m = {}; return {getItem: function(k){ return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; }, setItem: function(k, v){ m[k] = String(v); }, removeItem: function(k){ delete m[k]; }}; })();
  // timers: the page defers some work (more balances, counts); drain() runs it all, one after another, until nothing is left
  var __timers = [];
  var setTimeout = function(fn){ __timers.push(fn); return __timers.length; };
  var clearTimeout = function(){};
  var requestAnimationFrame = function(fn){ __timers.push(fn); return __timers.length; };
  function drain(){ var n = 0, f; while(__timers.length && n < 20000){ f = __timers.shift(); try{ f(); }catch(e){ if(HOST.error) HOST.error(e); } n++; } }
  // the controls: every id the page asks for is an inert stand-in that accepts what the page writes to it
  function El(){ this.dataset = {}; this.style = {}; this.children = []; this.childNodes = []; this.options = []; this.value = ''; this.innerHTML = ''; this.textContent = ''; this.innerText = ''; this.className = '';
    this.id = ''; this.title = ''; this.href = ''; this.src = ''; this.type = ''; this.checked = false; this.hidden = false; this.disabled = false; this.open = false; this.scrollTop = 0; this.scrollHeight = 0;
    this.clientWidth = 1000; this.clientHeight = 600; this.offsetWidth = 1000; this.offsetHeight = 600; this.length = 0;
    var self = this; this.classList = {add: function(){}, remove: function(){}, toggle: function(){}, contains: function(){ return false; }}; this.parentNode = self; this.parentElement = self; }
  ['querySelector', 'closest', 'getElementById', 'createElement', 'appendChild', 'insertBefore', 'cloneNode', 'removeChild', 'createElementNS'].forEach(function(m){ El.prototype[m] = function(){ return new El(); }; });
  ['addEventListener', 'removeEventListener', 'setAttribute', 'removeAttribute', 'focus', 'blur', 'click', 'select', 'remove', 'scrollIntoView', 'setSelectionRange', 'insertAdjacentHTML', 'dispatchEvent', 'append', 'prepend', 'replaceChildren', 'observe', 'disconnect', 'scrollTo'].forEach(function(m){ El.prototype[m] = function(){}; });
  El.prototype.querySelectorAll = function(){ return []; };
  El.prototype.getAttribute = function(){ return null; };
  El.prototype.contains = function(){ return false; };
  El.prototype.matches = function(){ return false; };
  El.prototype.getBoundingClientRect = function(){ return {left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0}; };
  var __els = {};
  var document = new El();
  document.getElementById = function(id){ return __els[id] || (__els[id] = new El()); };
  document.body = new El(); document.documentElement = new El(); document.head = new El(); document.addEventListener = function(){};
  var window = {addEventListener: function(){}, removeEventListener: function(){}, innerWidth: 1400, innerHeight: 900, scrollX: 0, scrollY: 0, matchMedia: function(){ return {matches: false, addListener: function(){}}; }, getComputedStyle: function(){ return {}; }};
  var getComputedStyle = window.getComputedStyle, matchMedia = window.matchMedia;
  var location = {search: '', href: '', pathname: ''};
  var history = {replaceState: function(){}, pushState: function(){}};
  var navigator = {userAgent: 'headless'};
  var confirm = function(){ return false; }, alert = function(){};
  var MutationObserver = function(){}; MutationObserver.prototype.observe = function(){}; MutationObserver.prototype.disconnect = function(){};
  var ResizeObserver = MutationObserver, IntersectionObserver = MutationObserver;
  var Image = function(){}; var Event = function(){}; var DOMParser = function(){};
  var fetch = function(url, opts){ return HOST.fetch(url, opts, {Blob: Blob, b64ToBytes: b64ToBytes}); };
  // the page formats numbers for en-US; a server may not know locales, so say how
  (function(){
    var fmt = function(n, opts){
      var minF = opts && opts.minimumFractionDigits !== undefined ? opts.minimumFractionDigits : 0;
      var maxF = opts && opts.maximumFractionDigits !== undefined ? opts.maximumFractionDigits : Math.max(minF, 3);
      if(!isFinite(n)) return String(n);
      var neg = n < 0 || (n === 0 && 1 / n < 0 && false), v = Math.abs(n), f = Math.pow(10, maxF);
      v = Math.round(v * f) / f;
      var s = v.toFixed(maxF), p = s.split('.'), ip = p[0], fp = p[1] || '';
      while(fp.length > minF && fp.charAt(fp.length - 1) === '0') fp = fp.slice(0, -1);
      ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      return (neg && (parseFloat(s) !== 0) ? '-' : '') + ip + (fp ? '.' + fp : '');
    };
    Number.prototype.toLocaleString = function(loc, opts){ return fmt(Number(this), opts); };
  })();
  if(!Array.prototype.flatMap) Array.prototype.flatMap = function(f, t){ return Array.prototype.concat.apply([], this.map(f, t)); };
  if(!Array.prototype.flat) Array.prototype.flat = function(){ return Array.prototype.concat.apply([], this); };
  if(!Object.fromEntries) Object.fromEntries = function(it){ var o = {}; it.forEach(function(kv){ o[kv[0]] = kv[1]; }); return o; };
  if(!String.prototype.padStart) String.prototype.padStart = function(n, c){ var s = String(this); c = c === undefined ? ' ' : String(c); while(s.length < n) s = c + s; return s; };
  if(!String.prototype.padEnd) String.prototype.padEnd = function(n, c){ var s = String(this); c = c === undefined ? ' ' : String(c); while(s.length < n) s += c; return s; };
'''

body = ("/**\n * Nussbaum Reporting Lab — the report engine, without a browser.\n *\n * GENERATED from nts_is_cpm_page.html by build_engine.py: do not edit by hand. It is the page's own calculation and\n"
        " * export code, so a scheduled report is built exactly as the page builds it. The Scheduled Script (nts_is_cpm_sched.js)\n"
        " * loads this module, hands it a host that answers the data requests, and collects the Excel and PDF it makes.\n"
        " * Upload it to the File Cabinet beside the page and the Scheduled Script, and upload a new copy whenever the page changes.\n */\n"
        "define([], function(){\n'use strict';\nreturn function createEngine(HOST){\n" + prelude + "\n" + xlsx_block + "\n" + t.replace('return __api;', 'return {api: __api, drain: drain, utf8: utf8, bytesToB64: bytesToB64};') + "\n};\n});\n")
open(out_path, 'w', encoding='utf-8').write(body)
print('wrote', out_path, len(body))
