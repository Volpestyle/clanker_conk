import crypto from "node:crypto";
import { clamp } from "./utils.ts";

const DEFAULT_SESSION_TTL_MINUTES = 12;
const MIN_SESSION_TTL_MINUTES = 2;
const MAX_SESSION_TTL_MINUTES = 30;
const MAX_ACTIVE_SESSIONS = 240;

export class ScreenShareSessionManager {
  constructor({ appConfig, store, bot, publicHttpsEntrypoint }) {
    this.appConfig = appConfig || {};
    this.store = store;
    this.bot = bot;
    this.publicHttpsEntrypoint = publicHttpsEntrypoint;
    this.sessions = new Map();
  }

  getRuntimeState() {
    this.cleanupExpiredSessions();
    const activeCount = this.sessions.size;
    let newestExpiresAt = null;
    for (const session of this.sessions.values()) {
      if (!newestExpiresAt || session.expiresAt > newestExpiresAt) {
        newestExpiresAt = session.expiresAt;
      }
    }
    return {
      activeCount,
      newestExpiresAt: newestExpiresAt ? new Date(newestExpiresAt).toISOString() : null
    };
  }

  getLinkCapability() {
    const publicState = this.publicHttpsEntrypoint?.getState?.() || null;
    const publicUrl = String(publicState?.publicUrl || "").trim();
    return {
      enabled: Boolean(publicUrl),
      status: String(publicState?.status || "disabled"),
      publicUrl
    };
  }

  cleanupExpiredSessions(nowMs = Date.now()) {
    for (const [token, session] of this.sessions.entries()) {
      if (Number(session.expiresAt || 0) <= nowMs) {
        this.sessions.delete(token);
      }
    }
    if (this.sessions.size <= MAX_ACTIVE_SESSIONS) return;
    const entries = [...this.sessions.entries()].sort(
      (a, b) => Number(a[1]?.createdAt || 0) - Number(b[1]?.createdAt || 0)
    );
    for (const [token] of entries) {
      if (this.sessions.size <= MAX_ACTIVE_SESSIONS) break;
      this.sessions.delete(token);
    }
  }

  getSessionByToken(rawToken) {
    this.cleanupExpiredSessions();
    const token = String(rawToken || "").trim();
    if (!token) return null;
    return this.sessions.get(token) || null;
  }

  getPublicShareUrlForToken(token) {
    const publicUrl = String(this.publicHttpsEntrypoint?.getState?.()?.publicUrl || "")
      .trim()
      .replace(/\/$/, "");
    if (!publicUrl || !token) return "";
    return `${publicUrl}/share/${encodeURIComponent(token)}`;
  }

  async createSession({
    guildId,
    channelId,
    requesterUserId,
    requesterDisplayName = "",
    targetUserId = null,
    source = "screen_share_offer"
  }) {
    this.cleanupExpiredSessions();
    const normalizedGuildId = String(guildId || "").trim();
    const normalizedChannelId = String(channelId || "").trim() || null;
    const normalizedRequesterUserId = String(requesterUserId || "").trim();
    const normalizedTargetUserId = String(targetUserId || normalizedRequesterUserId).trim();

    if (!normalizedGuildId || !normalizedRequesterUserId) {
      return {
        ok: false,
        reason: "invalid_share_request",
        message: "can't create a share link from this context."
      };
    }

    const publicShareBaseUrl = String(this.publicHttpsEntrypoint?.getState?.()?.publicUrl || "").trim();
    if (!publicShareBaseUrl) {
      return {
        ok: false,
        reason: "public_https_unavailable",
        message: "public share link is unavailable right now."
      };
    }

    const settings = this.store.getSettings();
    const watchResult = await this.bot?.voiceSessionManager?.enableWatchStreamForUser?.({
      guildId: normalizedGuildId,
      requesterUserId: normalizedRequesterUserId,
      targetUserId: normalizedTargetUserId,
      settings,
      source
    });
    if (!watchResult?.ok) {
      return {
        ok: false,
        reason: String(watchResult?.reason || "stream_watch_unavailable"),
        message: String(
          watchResult?.fallback ||
            "can't start screen-share watching right now. make sure we're in vc together and stream watch is enabled."
        )
      };
    }

    const sessionTtlMinutes = clamp(
      Number(this.appConfig?.publicShareSessionTtlMinutes) || DEFAULT_SESSION_TTL_MINUTES,
      MIN_SESSION_TTL_MINUTES,
      MAX_SESSION_TTL_MINUTES
    );
    const nowMs = Date.now();
    const token = crypto.randomBytes(18).toString("base64url");
    const expiresAt = nowMs + sessionTtlMinutes * 60_000;
    const session = {
      token,
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      requesterUserId: normalizedRequesterUserId,
      requesterDisplayName: String(requesterDisplayName || "").trim().slice(0, 80) || null,
      targetUserId: normalizedTargetUserId,
      source: String(source || "screen_share_offer").trim().slice(0, 80) || "screen_share_offer",
      createdAt: nowMs,
      expiresAt,
      lastFrameAt: 0
    };
    this.sessions.set(token, session);

    const shareUrl = this.getPublicShareUrlForToken(token);
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.channelId,
      userId: session.requesterUserId,
      content: "screen_share_session_created",
      metadata: {
        tokenSuffix: token.slice(-8),
        source: session.source,
        expiresAt: new Date(expiresAt).toISOString(),
        targetUserId: session.targetUserId,
        shareHost: safeUrlHost(shareUrl)
      }
    });

    return {
      ok: true,
      token,
      shareUrl,
      expiresAt: new Date(expiresAt).toISOString(),
      expiresInMinutes: sessionTtlMinutes,
      targetUserId: session.targetUserId
    };
  }

  async ingestFrameByToken({ token, mimeType = "image/jpeg", dataBase64 = "", source = "screen_share_page" }) {
    const session = this.getSessionByToken(token);
    if (!session) {
      return {
        accepted: false,
        reason: "share_session_not_found"
      };
    }

    const voicePresence = this.validateSessionVoicePresence(session);
    if (!voicePresence.ok) {
      this.stopSessionByToken({
        token: session.token,
        reason: voicePresence.reason
      });
      return {
        accepted: false,
        reason: voicePresence.reason
      };
    }

    let result = await this.bot.ingestVoiceStreamFrame({
      guildId: session.guildId,
      streamerUserId: session.targetUserId,
      mimeType,
      dataBase64,
      source
    });

    if (!result?.accepted && result?.reason === "watch_not_active") {
      const settings = this.store.getSettings();
      const watchResult = await this.bot?.voiceSessionManager?.enableWatchStreamForUser?.({
        guildId: session.guildId,
        requesterUserId: session.requesterUserId,
        targetUserId: session.targetUserId,
        settings,
        source: "screen_share_frame_rearm"
      });
      if (watchResult?.ok) {
        result = await this.bot.ingestVoiceStreamFrame({
          guildId: session.guildId,
          streamerUserId: session.targetUserId,
          mimeType,
          dataBase64,
          source
        });
      }
    }

    if (result?.accepted) {
      session.lastFrameAt = Date.now();
    }
    return result || { accepted: false, reason: "unknown" };
  }

  validateSessionVoicePresence(session) {
    const voiceManager = this.bot?.voiceSessionManager || null;
    if (!voiceManager || typeof voiceManager.getSession !== "function") {
      return {
        ok: false,
        reason: "voice_session_not_found"
      };
    }

    const voiceSession = voiceManager.getSession(String(session?.guildId || "").trim());
    if (!voiceSession || voiceSession.ending) {
      return {
        ok: false,
        reason: "voice_session_not_found"
      };
    }

    if (typeof voiceManager.isUserInSessionVoiceChannel === "function") {
      const requesterPresent = voiceManager.isUserInSessionVoiceChannel({
        session: voiceSession,
        userId: session.requesterUserId
      });
      if (!requesterPresent) {
        return {
          ok: false,
          reason: "requester_not_in_same_vc"
        };
      }

      if (session.targetUserId) {
        const targetPresent = voiceManager.isUserInSessionVoiceChannel({
          session: voiceSession,
          userId: session.targetUserId
        });
        if (!targetPresent) {
          return {
            ok: false,
            reason: "target_user_not_in_same_vc"
          };
        }
      }
    }

    return { ok: true };
  }

  stopSessionByToken({ token, reason = "stopped_by_user" }) {
    const session = this.getSessionByToken(token);
    if (!session) return false;
    this.sessions.delete(session.token);
    this.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.channelId,
      userId: session.requesterUserId,
      content: "screen_share_session_stopped",
      metadata: {
        tokenSuffix: String(session.token || "").slice(-8),
        reason: String(reason || "stopped_by_user").slice(0, 80)
      }
    });
    return true;
  }

  renderSharePage(token) {
    const session = this.getSessionByToken(token);
    if (!session) {
      return {
        statusCode: 404,
        html: buildInvalidSharePageHtml("This share link is invalid or expired.")
      };
    }

    const frameApiPath = `/api/voice/share-session/${encodeURIComponent(session.token)}/frame`;
    const stopApiPath = `/api/voice/share-session/${encodeURIComponent(session.token)}/stop`;
    return {
      statusCode: 200,
      html: buildSharePageHtml({
        expiresAtIso: new Date(session.expiresAt).toISOString(),
        frameApiPath,
        stopApiPath
      })
    };
  }
}

function buildInvalidSharePageHtml(message) {
  const text = String(message || "Invalid link.").slice(0, 220);
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\" />",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
    "<title>clanker conk - link unavailable</title>",
    "<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\" />",
    "<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin />",
    "<link href=\"https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;600;700&display=swap\" rel=\"stylesheet\" />",
    "<style>",
    "*{margin:0;padding:0;box-sizing:border-box}",
    "body{font-family:'Chakra Petch',system-ui,sans-serif;min-height:100vh;display:grid;place-items:center;background:#080c14;color:#e4ecf7;overflow:hidden}",
    "body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(20,32,56,.12) 1px,transparent 1px),linear-gradient(90deg,rgba(20,32,56,.12) 1px,transparent 1px);background-size:48px 48px;pointer-events:none}",
    "body::after{content:'';position:fixed;inset:0;pointer-events:none;background:repeating-linear-gradient(transparent,transparent 2px,rgba(0,0,0,.04) 2px,rgba(0,0,0,.04) 4px)}",
    ".wrap{position:relative;z-index:1;text-align:center;padding:40px 24px}",
    ".brand{font-size:10px;font-weight:600;letter-spacing:5px;color:#2a3d5e;text-transform:uppercase;margin-bottom:40px}",
    ".signal{font-size:clamp(36px,8vw,56px);font-weight:700;letter-spacing:3px;color:#1a2844;text-transform:uppercase;line-height:1.1;margin-bottom:20px;position:relative}",
    ".signal::before{content:'NO SIGNAL';position:absolute;left:2px;top:2px;color:rgba(0,212,255,.08);clip-path:inset(0 0 50% 0)}",
    ".signal::after{content:'NO SIGNAL';position:absolute;left:-2px;top:-1px;color:rgba(255,59,79,.06);clip-path:inset(50% 0 0 0)}",
    ".msg{font-size:14px;color:#3a5178;line-height:1.7;max-width:380px;margin:0 auto 32px}",
    ".bar{width:80px;height:2px;background:#182742;margin:0 auto;border-radius:1px;overflow:hidden}",
    ".bar-inner{width:30%;height:100%;background:#2a3d5e;animation:scan 2s ease-in-out infinite}",
    "@keyframes scan{0%{transform:translateX(-100%)}100%{transform:translateX(360%)}}",
    "</style>",
    "</head>",
    "<body>",
    "<div class=\"wrap\">",
    "<div class=\"brand\">clanker conk</div>",
    "<div class=\"signal\">NO SIGNAL</div>",
    "<div class=\"msg\">",
    escapeHtml(text),
    "</div>",
    "<div class=\"bar\"><div class=\"bar-inner\"></div></div>",
    "</div>",
    "</body>",
    "</html>"
  ].join("");
}

function buildSharePageHtml({ expiresAtIso, frameApiPath, stopApiPath }) {
  const safeExpiresAtIso = escapeJsString(String(expiresAtIso || ""));
  const safeFrameApiPath = escapeJsString(String(frameApiPath || ""));
  const safeStopApiPath = escapeJsString(String(stopApiPath || ""));

  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\" />",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
    "<title>clanker conk - screen share</title>",
    "<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\" />",
    "<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin />",
    "<link href=\"https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;500;600;700&display=swap\" rel=\"stylesheet\" />",
    "<style>",
    ":root{--bg:#080c14;--card:#0c1220;--surface:#111a2c;--inset:#0a0f1a;--border:#182742;--border-hi:#1e3355;--text:#e4ecf7;--text-mid:#8b9dc0;--text-dim:#4a5f82;--cyan:#00d4ff;--cyan-g:rgba(0,212,255,.12);--red:#ff3b4f;--red-g:rgba(255,59,79,.12);--amber:#ffb020;--green:#34d399}",
    "*{margin:0;padding:0;box-sizing:border-box}",
    "body{font-family:'Chakra Petch',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:grid;place-items:center;padding:16px}",
    "body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(20,32,56,.1) 1px,transparent 1px),linear-gradient(90deg,rgba(20,32,56,.1) 1px,transparent 1px);background-size:52px 52px;mask-image:radial-gradient(ellipse at center,black 0%,transparent 70%);-webkit-mask-image:radial-gradient(ellipse at center,black 0%,transparent 70%);pointer-events:none}",
    ".card{position:relative;z-index:1;width:min(100%,640px);background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.5)}",
    // -- header bar --
    ".hdr{display:flex;align-items:center;gap:8px;padding:10px 16px;background:var(--surface);border-bottom:1px solid var(--border);font-size:10px;font-weight:600;letter-spacing:2.5px;text-transform:uppercase;color:var(--text-dim)}",
    ".hdr .logo{color:var(--cyan);font-size:11px;letter-spacing:3px}",
    ".hdr .sep{color:var(--border-hi);font-weight:400}",
    // -- video area --
    ".vid-wrap{position:relative;background:var(--inset);border-bottom:1px solid var(--border);min-height:100px}",
    ".vid-wrap #preview{display:block;width:100%;max-height:380px;object-fit:contain;background:transparent}",
    ".vid-wrap::after{content:'';position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(transparent,transparent 2px,rgba(0,0,0,.05) 2px,rgba(0,0,0,.05) 4px)}",
    ".vid-ph{position:absolute;inset:0;display:grid;place-items:center;color:var(--text-dim);font-size:12px;letter-spacing:1.5px;text-transform:uppercase;transition:opacity .3s}",
    "[data-state=sharing] .vid-ph,[data-state=stopped] .vid-ph{opacity:0;pointer-events:none}",
    // -- REC badge --
    ".rec{position:absolute;top:10px;right:10px;z-index:2;display:none;align-items:center;gap:5px;padding:3px 9px;border-radius:4px;background:rgba(255,59,79,.88);font-size:9px;font-weight:700;letter-spacing:1.5px;color:#fff;text-transform:uppercase;backdrop-filter:blur(4px)}",
    ".rec .rdot{width:6px;height:6px;border-radius:50%;background:#fff;animation:pulse 1.2s ease-in-out infinite}",
    "[data-state=sharing] .rec{display:flex}",
    "@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}",
    // -- stats bar --
    ".stats{display:flex;align-items:center;gap:14px;padding:9px 16px;border-bottom:1px solid var(--border);font-size:11px;letter-spacing:.5px;color:var(--text-dim)}",
    ".stats .ind{display:flex;align-items:center;gap:6px}",
    ".stats .dot{width:7px;height:7px;border-radius:50%;background:var(--text-dim);transition:background .3s,box-shadow .3s}",
    ".stats .dot.live{background:var(--green);box-shadow:0 0 8px var(--green);animation:pulse 1.2s ease-in-out infinite}",
    ".stats .dot.stopped{background:var(--red)}",
    ".stats .dot.expired{background:var(--amber)}",
    ".stats .itxt{font-weight:600;letter-spacing:1px;transition:color .3s}",
    ".stats .itxt.live{color:var(--green)}",
    ".stats .itxt.stopped{color:var(--red)}",
    ".stats .itxt.expired{color:var(--amber)}",
    ".stats .spacer{flex:1}",
    ".stats .lbl{color:var(--text-dim);margin-right:3px}",
    ".stats .val{color:var(--text-mid);font-weight:500}",
    ".stats .pipe{color:var(--border-hi);margin:0 2px}",
    // -- body --
    ".body{padding:16px}",
    ".desc{font-size:13px;color:var(--text-mid);line-height:1.55;margin-bottom:14px}",
    ".desc strong{color:var(--text);font-weight:600}",
    // -- buttons --
    ".actions{display:flex;gap:8px;margin-bottom:12px}",
    ".btn{border:0;border-radius:6px;padding:10px 20px;font-family:'Chakra Petch',system-ui,sans-serif;font-size:12px;font-weight:600;letter-spacing:.8px;cursor:pointer;transition:all .2s;text-transform:uppercase}",
    ".btn-go{background:var(--cyan);color:var(--bg);box-shadow:0 0 24px var(--cyan-g),inset 0 1px 0 rgba(255,255,255,.15)}",
    ".btn-go:hover:not(:disabled){background:#2ee0ff;box-shadow:0 0 32px rgba(0,212,255,.22),inset 0 1px 0 rgba(255,255,255,.2)}",
    ".btn-go:active:not(:disabled){transform:scale(.97)}",
    ".btn-stop{background:var(--surface);border:1px solid var(--border-hi);color:var(--text-mid)}",
    ".btn-stop:hover:not(:disabled){background:var(--red-g);border-color:var(--red);color:var(--red)}",
    ".btn:disabled{opacity:.3;cursor:not-allowed}",
    // -- status log --
    "#status{font-family:'SF Mono','Cascadia Code',ui-monospace,monospace;font-size:11px;color:var(--text-dim);padding:8px 12px;border-radius:6px;background:var(--inset);border:1px solid var(--border);white-space:pre-wrap;min-height:18px;line-height:1.4}",
    // -- time bar --
    ".tbar{height:3px;background:var(--surface)}",
    ".tbar-fill{height:100%;background:var(--cyan);transition:width 1s linear,background .5s}",
    ".tbar-fill.warn{background:var(--amber)}",
    ".tbar-fill.crit{background:var(--red)}",
    // -- glow border on sharing --
    "[data-state=sharing] .card{border-color:rgba(0,212,255,.2);box-shadow:0 24px 80px rgba(0,0,0,.5),0 0 40px rgba(0,212,255,.06)}",
    "[data-state=stopped] .card{border-color:rgba(255,59,79,.15)}",
    "</style>",
    "</head>",
    "<body data-state=\"idle\">",
    "<main class=\"card\">",
    "<div class=\"hdr\"><span class=\"logo\">clanker conk</span><span class=\"sep\">/</span><span>screen share</span></div>",
    "<div class=\"vid-wrap\">",
    "<div class=\"vid-ph\">select a screen to begin</div>",
    "<div class=\"rec\"><span class=\"rdot\"></span>REC</div>",
    "<video id=\"preview\" autoplay muted playsinline></video>",
    "</div>",
    "<div class=\"stats\">",
    "<div class=\"ind\"><span class=\"dot\" id=\"ind-dot\"></span><span class=\"itxt\" id=\"ind-txt\">READY</span></div>",
    "<span class=\"spacer\"></span>",
    "<span class=\"lbl\">time</span><span class=\"val\" id=\"countdown\">--:--</span>",
    "<span class=\"pipe\">|</span>",
    "<span class=\"lbl\">frames</span><span class=\"val\" id=\"fcnt\">0</span>",
    "</div>",
    "<div class=\"body\">",
    "<div class=\"desc\">Click <strong>Start Sharing</strong>, pick the app or screen to share, and keep this tab open while clanker watches.</div>",
    "<div class=\"actions\">",
    "<button id=\"start\" class=\"btn btn-go\">Start Sharing</button>",
    "<button id=\"stop\" class=\"btn btn-stop\" disabled>Stop</button>",
    "</div>",
    "<pre id=\"status\">waiting to start</pre>",
    "</div>",
    "<div class=\"tbar\"><div class=\"tbar-fill\" id=\"tbar\" style=\"width:100%\"></div></div>",
    "</main>",
    "<script>",
    `const EXPIRES_AT='${safeExpiresAtIso}';`,
    `const FRAME_API_PATH='${safeFrameApiPath}';`,
    `const STOP_API_PATH='${safeStopApiPath}';`,
    "const FRAME_INTERVAL_MS=900;",
    "const MAX_WIDTH=960;",
    "const JPEG_QUALITY=0.62;",
    "const startBtn=document.getElementById('start');",
    "const stopBtn=document.getElementById('stop');",
    "const preview=document.getElementById('preview');",
    "const statusEl=document.getElementById('status');",
    "const indDot=document.getElementById('ind-dot');",
    "const indTxt=document.getElementById('ind-txt');",
    "const countdownEl=document.getElementById('countdown');",
    "const fcntEl=document.getElementById('fcnt');",
    "const tbar=document.getElementById('tbar');",
    "const expiresMs=new Date(EXPIRES_AT).getTime();",
    "const pageLoadMs=Date.now();",
    "const totalMs=Math.max(1,expiresMs-pageLoadMs);",
    "let stream=null;",
    "let timer=null;",
    "let sending=false;",
    "let frameCount=0;",
    "let canvas=document.createElement('canvas');",
    "let ctx=canvas.getContext('2d');",
    "function setStatus(t){statusEl.textContent=String(t||'');}",
    "function setState(s){",
    "document.body.dataset.state=s;",
    "indDot.className='dot'+(s==='sharing'?' live':s==='stopped'?' stopped':s==='expired'?' expired':'');",
    "indTxt.className='itxt'+(s==='sharing'?' live':s==='stopped'?' stopped':s==='expired'?' expired':'');",
    "indTxt.textContent=s==='sharing'?'LIVE':s==='stopped'?'STOPPED':s==='expired'?'EXPIRED':'READY';",
    "}",
    "function updateCountdown(){",
    "const rem=Math.max(0,expiresMs-Date.now());",
    "const pct=Math.max(0,rem/totalMs*100);",
    "const m=Math.floor(rem/60000);const s=Math.floor((rem%60000)/1000);",
    "countdownEl.textContent=String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');",
    "tbar.style.width=pct+'%';",
    "tbar.className='tbar-fill'+(pct<15?' crit':pct<33?' warn':'');",
    "if(rem<=0&&stream){stopShare('session_expired');setState('expired');}",
    "if(rem<=0&&!stream){setState('expired');setStatus('session expired');}",
    "}",
    "setInterval(updateCountdown,1000);updateCountdown();",
    "function stopTracks(){if(!stream)return;for(const t of stream.getTracks())t.stop();}",
    "async function stopShare(reason='user_stop'){",
    "if(timer){clearInterval(timer);timer=null;}",
    "stopTracks();",
    "stream=null;",
    "preview.srcObject=null;",
    "startBtn.disabled=false;",
    "stopBtn.disabled=true;",
    "if(reason!=='session_expired')setState('stopped');",
    "try{await fetch(STOP_API_PATH,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason})});}catch{}",
    "setStatus('stopped \\u00b7 '+reason);",
    "}",
    "async function sendCurrentFrame(){",
    "if(!stream||sending)return;",
    "const videoTrack=stream.getVideoTracks()[0];",
    "if(!videoTrack)return;",
    "const vw=preview.videoWidth||0;const vh=preview.videoHeight||0;",
    "if(vw<2||vh<2)return;",
    "const scale=Math.min(1,MAX_WIDTH/vw);",
    "canvas.width=Math.max(2,Math.floor(vw*scale));",
    "canvas.height=Math.max(2,Math.floor(vh*scale));",
    "ctx.drawImage(preview,0,0,canvas.width,canvas.height);",
    "sending=true;",
    "try{",
    "const blob=await new Promise((r)=>canvas.toBlob(r,'image/jpeg',JPEG_QUALITY));",
    "if(!blob)throw new Error('frame_encode_failed');",
    "const dataUrl=await new Promise((r,j)=>{const f=new FileReader();f.onload=()=>r(String(f.result||''));f.onerror=()=>j(new Error('read_failed'));f.readAsDataURL(blob);});",
    "const base64=String(dataUrl).split(',')[1]||'';",
    "const res=await fetch(FRAME_API_PATH,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mimeType:'image/jpeg',dataBase64:base64,source:'share_page'})});",
    "let body={};try{body=await res.json();}catch{}",
    "if(!res.ok||body.accepted===false){setStatus('frame rejected \\u00b7 '+(body.reason||res.status));return;}",
    "frameCount++;fcntEl.textContent=String(frameCount);",
    "setStatus('sharing live \\u00b7 '+new Date().toLocaleTimeString());",
    "}catch(err){setStatus('send error \\u00b7 '+(err&&err.message?err.message:String(err)));}",
    "finally{sending=false;}",
    "}",
    "startBtn.addEventListener('click',async()=>{",
    "if(stream)return;",
    "try{",
    "stream=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:2},audio:false});",
    "preview.srcObject=stream;",
    "await preview.play();",
    "for(const track of stream.getVideoTracks()){track.addEventListener('ended',()=>{stopShare('browser_stream_ended');});}",
    "startBtn.disabled=true;",
    "stopBtn.disabled=false;",
    "setState('sharing');",
    "setStatus('capturing screen...');",
    "timer=setInterval(sendCurrentFrame,FRAME_INTERVAL_MS);",
    "sendCurrentFrame();",
    "}catch(err){",
    "stream=null;",
    "setStatus('start failed \\u00b7 '+(err&&err.message?err.message:String(err)));",
    "}",
    "});",
    "stopBtn.addEventListener('click',()=>stopShare('manual_stop'));",
    "</script>",
    "</body>",
    "</html>"
  ].join("");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeJsString(value) {
  return String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("</", "<\\/");
}

function safeUrlHost(rawUrl) {
  const text = String(rawUrl || "").trim();
  if (!text) return "";
  try {
    return String(new URL(text).host || "").trim().slice(0, 160);
  } catch {
    return "";
  }
}
