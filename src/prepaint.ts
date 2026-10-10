// prepaint.ts: the one piece of robo-vision that must be synchronous, as a
// string for the host to ship. The build writes it to dist/prepaint.js and
// prints its CSP digest; demo/serve.ts inlines it.
//
// Inline it in <head>, or load dist/prepaint.js there as a classic script.
// robo-vision itself is a module, and a module runs after the page has
// painted, so without this a machine link paints the human page first and then
// swaps. That is the flash Cloudflare's own snippet exists to prevent. It
// applies the requested mode to <html>, and for a machine view it hides the
// page until the pane is up (or for PENDING_MS, whichever is first). The hide
// is a CSSOM write rather than a <style>, so a CSP that forbids inline styles
// still allows it.
import { ATTR, KEY, PARAM, PENDING, PENDING_MS } from "./mode.ts";

const j = JSON.stringify;
export const PREPAINT = `(function(){try{var d=document.documentElement,v=function(x){return x==="machine"||x==="human"},q=new URLSearchParams(location.search).get(${j(PARAM)}),m=v(q)?q:localStorage.getItem(${j(KEY)});if(!v(m))return;d.setAttribute(${j(ATTR)},m);if(m==="machine"){d.setAttribute(${j(PENDING)},"");d.style.visibility="hidden";setTimeout(function(){if(d.hasAttribute(${j(PENDING)})){d.removeAttribute(${j(PENDING)});d.style.removeProperty("visibility")}},${PENDING_MS})}}catch(e){}})();`;
