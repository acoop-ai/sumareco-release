/*
 * osechi.js — スマレコ「おせち受注」モード（2026）
 * 原本: osechi-ocr_Dev/SPEC.md（§3 区分・§4 窓口の約束・§5-15 画面の守り・§8 画面・§9 試験）
 *
 * 公開する入口は2つだけ:
 *   window.OsechiMode.open(ctx)   … モードを開く
 *   window.OsechiMode.close(opts) … モードを閉じる（作りかけは端末に残す）
 *       opts.byHost  … スマレコが閉じた（onClose を呼ばない）
 *       opts.discard … サインアウト: 作りかけを残さずに閉じる（このあとスマレコが端末の作りかけ・札を消す）
 *
 *   ctx = {
 *     container: Element          … 描く入れ物（スマレコの #osechi-screen・階層1・z-index 2000）
 *     apiUrl: string              … おせち窓口のアドレス（スマレコの定数 OSECHI_API_URL）
 *     getSumarecoToken(): string  … スマレコの札（期限切れなら空文字）
 *     profile: { email, shop }    … 表示の補助と、保存した札の持ち主の照合だけに使う。権限は窓口が決める
 *     onClose(): void             … こちらから閉じたいときに呼ぶ（スマレコが入れ物を隠す）
 *   }
 *
 * スマレコの進む／戻る（v79.0・階層）との約束（principles_screen_navigation_stack）:
 *   重ねる画面は3つの階層だけ。どれもスマレコの階層の表に登録してある（sumareco_hook.patch）。
 *     #osechi-screen … 階層1・z 2000。スマレコが出し入れする（入れ物）
 *     #osechi-sub    … 階層2・z 5000。使い方・写真・（後で）お客様リストの1件。こちらが body 直下に作る
 *     #osechi-dialog … 階層4・z 6000。確認の小窓と処理中の表示。こちらが body 直下に作る
 *   端末の戻る操作では、スマレコがいちばん手前の1枚に 'hidden' を付ける。こちらは見張り（MutationObserver）で
 *   気づいて後片付けする。小窓は「やめる」として受け取る（送信中だけは閉じずに戻す＝結果が分からなくなるため）。
 *
 * 信頼境界: 窓口の応答・AI の読み取り・利用者の入力・端末に残した作りかけは、すべて信用しない文字。
 *   画面へは textContent／setAttribute（許可した属性だけ）で入れる。HTML を文字列で差し込まない。
 *   AI の読み取りは「候補」。店・送り先・操作を AI の出力で決めない（人が確かめて送る）。
 *
 * 商品の番号・数・種類は決め打ちしない。窓口の getConfig の items（最大40）だけで描く（載っていない番号は出さない）。
 *   kind:'method' … 店渡しの数と宅配の数を別々に持つ商品（2026年の様式は 1〜19・お渡しは 12/31 のみ）
 *                   → 注文の items: [{ no, storeQty, deliveryQty }]（SPEC 追補 v2 §12。両方 0 は送らない）
 *   kind:'date'   … お渡し日を選ぶ商品（2026年は 27 番だけ＝追補 v3 §19。候補の日付は getConfig の dates だけ）
 *                   お渡し日は複数選べて、日ごとに個数を入れる（用紙の個数欄は1つなので、日ごとの個数は人が入れる）
 *                   → 注文の datedItems: [{ no, pickupDate, qty }]（同じ番号で日付ごとに1つ・日付の重なりは形で起きない）
 *                   日付を選んで個数が空のままは送れない（注意の確認では越えられない必須の入力＝DATE_QTY_NEEDED）。
 * 窓口が返す注意（元日・宅配の地域・宅配のお引取り時間など）は flags.warnings。黄色の帯で見せ、
 *   人が「確認したうえでこのまま送る」を選んだときだけ allowWarnings:true を付けて送る（空いている必須の欄は allowMissing）。
 *   窓口が「確かめてから」と断る形は NEEDS_CONFIRM（error.missing・error.warnings）。古い形（BAD_REQUEST）にも合わせる。
 *
 * 後から足す画面（お客様リスト＝SPEC §17）のための作り:
 *   ・窓口を呼ぶのは api(action, args) の1か所（action ごとの待ち時間・送り直しは ACTION_OPTS の表）。
 *   ・モードの中の切り替え（「注文を入れる」「お客様リスト」）は VIEWS の表に1行足すと、上部の切り替えに出る
 *     （2つ以上あるときだけ出す）。中身は host（api・小窓・処理中・階層2・本文と下の操作の場所）を受け取って描く。
 *   ・階層2（#osechi-sub）は openSub(title, body)／closeSub() の1か所で出し入れする。
 */
(function (root) {
  'use strict';

  // ===== 版・定数 =====
  var OSECHI_UI_BUILD = 'osechi-ui-2026-10-29a';
  var SESSION_KEY = 'osechi_session_v1';        // sessionStorage（このタブだけ・閉じれば消える）
  var LAST_DONE_KEY = 'osechi_last_done_v1';    // sessionStorage（直前の受付番号だけ）
  var DRAFT_DB = 'osechi_drafts_v1';            // IndexedDB（作りかけ・12時間）
  var DRAFT_STORE = 'drafts';
  var DRAFT_TTL_MS = 12 * 60 * 60 * 1000;
  // localStorage（個人情報なし＝時刻と理由だけ）。端末が画面を終了させたとき（カメラの間など）に、
  // スマレコが起動し直したあとで、このモードを開き直すための印。サインアウト・閉じる操作で消す
  var RESUME_KEY = 'osechi_resume_v1';
  var RESUME_TTL_MS = 30 * 60 * 1000;
  // 同じ印を IndexedDB にも置く（2026-10-29: Android で撮影の間に端末がブラウザごと終了させ、開き直したスマレコに印が無く、
  //   何も出ずにホームに戻った。localStorage は書いてから数秒、ディスクへの書き込みを待つことがあり、ブラウザごと終了すると消えうる＝推測。
  //   IndexedDB は書いた時点でディスクへ渡る）。読むのは localStorage → 無ければ IndexedDB。消すときは両方
  var RESUME_DB = 'osechi_resume_v1';
  var RESUME_STORE = 'mark';
  var RESUME_REC = 'm';
  // 印の段階: camera＝カメラ・アルバムを開いた（写真はまだ届いていない）／photo＝写真が届いて、整えて読み取っている途中
  var RESUME_NOTES = {
    camera: 'カメラを開いている間に、端末の都合で画面が閉じられたため、おせち受注を開き直しました。写真は届いていないので、もう一度「注文書を撮影して読み取る」を押してください。\n続けて起きるときは、ほかのアプリを閉じてから撮るか、端末のカメラで撮ってから「アルバムの写真から読み取る」を使ってください。',
    photo: '写真を整えて読み取っている途中で、端末の都合で画面が閉じられたため、おせち受注を開き直しました。写真は残っていないので、もう一度撮影するか、アルバムから選んでください。\n続けて起きるときは、ほかのアプリを閉じてから試してください。'
  };
  var MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  var LONG_EDGE = 2000;
  var JPEG_QUALITY = 0.82;
  var MAX_ITEMS = 40;
  var STYLE_ID = 'osechi-style';
  // この osechi.js を読み込んだアドレス（お客様リストの部品 osechi_list.js を、同じ場所・同じ版で読むため）
  var SELF_SRC = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) ? String(document.currentScript.src) : '';
  // 重ねる画面（階層）。スマレコの OVERLAY_LEVEL と同じ値・同じ z-index（sumareco_hook.patch・static_safety で照合）
  var LAYERS = {
    sub: { id: 'osechi-sub', level: 2, z: 5000 },
    dialog: { id: 'osechi-dialog', level: 4, z: 6000 }
  };
  var DIALOG_ID = LAYERS.dialog.id;
  var SUB_ID = LAYERS.sub.id;
  var LIMITS = { name: 40, address: 120, tel: 20, zip: 8, pickupTime: 20, store: 40, receptionist: 20 };
  // 受付係員（申込書のいちばん下の「受付係員名」）。空のまま送らない＝空・読めないときはこの文字（PO 2026-10-29・窓口も同じ）
  var RECEPTIONIST_NONE = '記載なし';
  var PARTY_FIELDS = ['name', 'zip', 'address', 'tel'];
  var PARTY_LABEL = { name: 'お名前', zip: '郵便番号', address: 'ご住所', tel: '電話番号' };
  var SIDE_LABEL = { receiver: 'お届け先', requester: 'ご依頼主' };
  // 窓口を呼ぶときの待ち時間と送り直し（api() だけが読む。後から足す操作もここに1行）
  var SESSION_TIMEOUT_MS = 30000;
  var ACTION_OPTS = {
    getConfig: { timeoutMs: 20000, retryNetwork: true },
    ocr: { timeoutMs: 90000, retryNetwork: false },
    checkOrder: { timeoutMs: 25000, retryNetwork: true },
    submitOrder: { timeoutMs: 45000, retryNetwork: true },
    adminStatus: { timeoutMs: 60000, retryNetwork: true },
    adminExportNow: { timeoutMs: 60000, retryNetwork: false },
    // お客様リスト（SPEC §17・BACKEND_NOTES §6）。読むだけの操作は通信の失敗で1回送り直す。
    //   書く操作（修正・取消）は submissionId を付けるので送り直しても1回。取り出し（xlsx・CSV）と印刷の記録は
    //   回数の上限に数えられるので、自動では送り直さない
    listCustomers: { timeoutMs: 30000, retryNetwork: true },
    getSummary: { timeoutMs: 30000, retryNetwork: true },
    getOrder: { timeoutMs: 20000, retryNetwork: true },
    updateOrder: { timeoutMs: 45000, retryNetwork: true },
    cancelOrder: { timeoutMs: 30000, retryNetwork: true },
    exportReport: { timeoutMs: 90000, retryNetwork: false, retryBusy: false },
    exportCsv: { timeoutMs: 60000, retryNetwork: false, retryBusy: false },
    logPrint: { timeoutMs: 15000, retryNetwork: false, retryBusy: false },
    // 受注状況一覧表（2026-10-29・REPORT_NOTES §8）: 見るのは送り直してよい・Excel は取り出しの上限に数えるので自動では送り直さない
    getProductionList: { timeoutMs: 30000, retryNetwork: true },
    exportProduction: { timeoutMs: 90000, retryNetwork: false, retryBusy: false }
  };
  var DEFAULT_ACTION_OPTS = { timeoutMs: 30000, retryNetwork: false };
  // 注意のうち、確認しても越えられないもの（日ごとの個数が空＝人が入れるまで送れない・追補 v3）
  var BLOCKING_WARNINGS = { DATE_QTY_NEEDED: 1 };
  // 元日（1/1）。受け渡しができるのは元日営業の店だけ（申込書の注記・窓口が店ごとに注意を返す）
  var NEW_YEAR_DATE = '1/1';

  // ===== 小さな道具（DOM を使わない＝Node でも試験できる） =====
  function str(v) { return v == null ? '' : String(v); }
  function toInt(v) {
    if (typeof v === 'string' && !/^\s*-?\d+\s*$/.test(v)) return NaN;
    var n = Number(v);
    return (isFinite(n) && Math.floor(n) === n) ? n : NaN;
  }
  function nfkc(s) { s = str(s); try { return s.normalize('NFKC'); } catch (e) { return s; } }
  // 制御文字・向きを変える文字（表示のなりすましに使われる）を除く。改行とタブは別に扱う
  var CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;
  function cleanText(v, max, multiline) {
    var s = str(v).replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(CTRL_RE, '');
    s = multiline ? s.replace(/\n{3,}/g, '\n\n') : s.replace(/\n+/g, ' ');
    s = s.trim();
    if (max && s.length > max) s = s.slice(0, max);
    return s;
  }
  function trim(v) { return str(v).trim(); }

  // ---- 「同上」「同じ」などの見分け（昨年の画面 isSameWord をそのまま引き継ぐ） ----
  var SAME_WORD_PAT = /^(?:同じ|同上|同右|同左|右に同じ|左に同じ|右同|左同|同|〃)$/;
  function isSameWord(val) {
    if (val == null) return false;
    var s = String(val).trim();
    if (!s) return false;
    s = s.replace(/[\s　]+/g, '');
    if (SAME_WORD_PAT.test(s)) return true;
    if (s === '同') return true;
    if (/^(?:左同|右同|左同上|右同上|左同じ|右同じ)$/.test(s)) return true;
    if (/^(?:佐同|在同|坐同)$/.test(s)) return true;
    if (/(同上|同じ|同右|同左|右に同じ|左に同じ|右同|左同|〃)/.test(s)) return true;
    if (s.length <= 4 && s.indexOf('同') >= 0 && /[左右上下佐在坐]/.test(s)) return true;
    return false;
  }
  function hasAnyInfo(p) {
    if (!p) return false;
    return !!(trim(p.name) || trim(p.zip) || trim(p.address) || trim(p.tel));
  }
  function emptyParty() { return { name: '', zip: '', address: '', tel: '' }; }

  /**
   * 「同上」などが書かれた欄を空にし、相手側の情報で埋める（昨年の applySameWordAutofillOnDom と同じ順・同じ条件）。
   * form.receiver / form.requester を直接書き換える。変えたら true。
   */
  function applySameWordAutofill(form) {
    var rec = form.receiver, req = form.requester, changed = false;
    var rawRec = {}, rawReq = {};
    PARTY_FIELDS.forEach(function (f) { rawRec[f] = trim(rec[f]); rawReq[f] = trim(req[f]); });
    PARTY_FIELDS.forEach(function (f) {
      if (isSameWord(rec[f])) { rec[f] = ''; changed = true; }
      if (isSameWord(req[f])) { req[f] = ''; changed = true; }
    });
    var recWants = PARTY_FIELDS.some(function (f) { return isSameWord(rawRec[f]); });
    var reqWants = PARTY_FIELDS.some(function (f) { return isSameWord(rawReq[f]); });
    var recClean = {}, reqClean = {};
    PARTY_FIELDS.forEach(function (f) {
      recClean[f] = isSameWord(rawRec[f]) ? '' : rawRec[f];
      reqClean[f] = isSameWord(rawReq[f]) ? '' : rawReq[f];
    });
    if (hasAnyInfo(reqClean) && recWants) {
      PARTY_FIELDS.forEach(function (f) { if (!recClean[f]) { rec[f] = str(req[f]); changed = true; } });
    }
    if (hasAnyInfo(recClean) && reqWants) {
      PARTY_FIELDS.forEach(function (f) { if (!reqClean[f]) { req[f] = str(rec[f]); changed = true; } });
    }
    return changed;
  }

  // ---- 店名の比べ方（昨年の normalizeStoreNameForSheet_・類似度 0.7 をそのまま引き継ぐ） ----
  function normalizeStoreKey(raw) {
    var s = nfkc(raw).replace(/店/g, '').replace(/[\s　]+/g, '');
    try { s = s.replace(new RegExp('[^\\p{L}\\p{N}]', 'gu'), ''); }
    catch (e) { s = s.replace(/[^0-9A-Za-z一-鿿ぁ-ゖァ-ヺー々〆〤]/g, ''); }
    return s;
  }
  function levenshtein(a, b) {
    a = str(a); b = str(b);
    var n = a.length, m = b.length, i, j;
    if (!n) return m;
    if (!m) return n;
    var prev = [], cur = [];
    for (j = 0; j <= m; j++) prev[j] = j;
    for (i = 1; i <= n; i++) {
      cur = [i];
      for (j = 1; j <= m; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      }
      prev = cur;
    }
    return prev[m];
  }
  function similarity(a, b) {
    var max = Math.max(str(a).length, str(b).length);
    return max ? 1 - levenshtein(a, b) / max : 1;
  }
  /** 注文書の店名から、店の一覧の中の「候補」を1つ選ぶ（決めるのは人）。無ければ null */
  function findStoreCandidate(raw, stores) {
    var key = normalizeStoreKey(raw);
    if (!key || !Array.isArray(stores)) return null;
    var best = null, bestScore = -1;
    for (var i = 0; i < stores.length; i++) {
      var k = normalizeStoreKey(stores[i]);
      if (!k) continue;
      var sc = (k === key) ? 1 : similarity(key, k);
      if (sc > bestScore) { bestScore = sc; best = stores[i]; }
    }
    return (best !== null && bestScore >= 0.7) ? { name: best, score: bestScore } : null;
  }
  /**
   * 窓口の flags.paperStore（用紙の「店舗名」の欄・2026-10-29 osechi-api-2026-10-29a から）を確かめて使う形にする。無い・壊れていれば null
   *   { raw: 読んだ店名, resolved: 店舗表の店名, how: 'exact'（1店に決まる）|'similar'（似ている＝候補）|'none'（店舗表に無い）|'empty'（読めない） }
   */
  var PAPER_HOW = { exact: 1, similar: 1, none: 1, empty: 1 };
  function sanitizePaperStore(p) {
    if (!p || typeof p !== 'object' || !PAPER_HOW[p.how]) return null;
    var raw = cleanText(p.raw, LIMITS.store), resolved = cleanText(p.resolved, LIMITS.store), how = p.how;
    if (how === 'empty') return { raw: '', resolved: '', how: 'empty' };
    if (!raw) return { raw: '', resolved: '', how: 'empty' };
    if ((how === 'exact' || how === 'similar') && !resolved) how = 'none';
    if (how === 'none') resolved = '';
    return { raw: raw, resolved: resolved, how: how };
  }
  /**
   * 店・店長: 注文書の店名が自店と違うか（送る前に「異なる店舗の予約ですが良いですか？」と確かめる）。違えば読んだ店名、同じ・空・読めないときは ''。
   *   paper（新しい窓口）があればそれで決める。無ければ（前の版の窓口）storeMatched と storeMessage「用紙の店名「…」は、この店…」から読む
   */
  function paperStoreDiffers(paper, flags, myStore) {
    if (paper) {
      if (paper.how === 'empty' || !paper.raw) return '';
      if ((paper.how === 'exact' || paper.how === 'similar') && paper.resolved === myStore) return '';
      return paper.raw;
    }
    if (!flags || flags.storeMatched !== false) return '';
    var m = str(flags.storeMessage).match(/^用紙の店名「([^」]{1,40})」は、この店/);
    return m ? cleanText(m[1], LIMITS.store) : '';
  }
  /** 本部: 注文書の店名が店の一覧の1店に決まるとき（how＝exact）、その店。決まらなければ '' */
  function paperStoreAuto(paper, stores) {
    if (!paper || paper.how !== 'exact' || !paper.resolved) return '';
    return (Array.isArray(stores) && stores.indexOf(paper.resolved) >= 0) ? paper.resolved : '';
  }
  /** 開き直しの印（{ at, stage }）。30分より古い・形が違えば null */
  function parseResumeMark(o, nowMs) {
    if (!o || typeof o !== 'object') return null;
    var age = (nowMs || Date.now()) - Number(o.at);
    if (!(age >= 0 && age < RESUME_TTL_MS)) return null;
    return { at: Number(o.at), stage: o.stage === 'photo' ? 'photo' : 'camera' };
  }
  function resumeNoteFor(mark) { return mark ? RESUME_NOTES[mark.stage === 'photo' ? 'photo' : 'camera'] : ''; }

  // ---- 数・日付・電話・郵便番号 ----
  var HYPHENS_RE = /[\u2010\u2011\u2012\u2013\u2014\u2015\u30FC\uFF0D\u2212\uFF70\u2212]/g;
  /** 数量: 空・0 は「注文なし」。1〜99 の整数だけを数量として認める */
  function parseQty(raw) {
    var s = nfkc(raw).replace(/[\s　]+/g, '');
    if (s === '') return { empty: true };
    if (!/^\d+$/.test(s)) return { error: '数字で入れてください' };
    var n = parseInt(s, 10);
    if (n === 0) return { empty: true };
    if (n > 99) return { error: '99 までです' };
    return { value: n };
  }
  /** 日付の書き方をそろえる（12月31日・１２／３１ → 12/31）。候補が渡されれば、候補にあるものだけ返す */
  function normalizeDate(raw, candidates) {
    var s = nfkc(raw).replace(/[\s　]+/g, '');
    var m = s.match(/^(\d{1,2})[\/月.\-](\d{1,2})日?$/);
    if (!m) return '';
    var d = Number(m[1]) + '/' + Number(m[2]);
    if (candidates && candidates.indexOf(d) < 0) return '';
    return d;
  }
  function normalizeTel(raw) {
    return nfkc(raw).replace(HYPHENS_RE, '-').replace(/[\s　()（）]+/g, '');
  }
  function normalizeZip(raw) {
    return nfkc(raw).replace(/^〒/, '').replace(HYPHENS_RE, '-').replace(/[\s　]+/g, '');
  }
  function isValidTel(s) { return s === '' || /^[0-9][0-9-]{0,19}$/.test(s); }
  function isValidZip(s) { return s === '' || /^\d{3}-?\d{4}$/.test(s); }

  // ---- 窓口の設定（getConfig）を確かめて使う形にする ----
  function sanitizeConfig(c) {
    c = (c && typeof c === 'object') ? c : {};
    // 受付期間: 窓口は { open: true|false（いま受け付けているか）, start, end }。古い形（open に開始日）にも合わせる
    var se = (c.season && typeof c.season === 'object') ? c.season : {};
    var lim = (c.limits && typeof c.limits === 'object') ? c.limits : {};
    var maxBytes = toInt(lim.imageMaxBytes != null ? lim.imageMaxBytes : lim.maxImageBytes);
    var out = {
      season: {
        isOpen: se.open === true ? true : (se.open === false ? false : null),
        start: cleanText(typeof se.open === 'string' ? se.open : se.start, 40),
        end: cleanText(se.end, 40)
      },
      // 写真の上限は窓口の値と 4MB の小さい方（窓口が小さくしたときに、送ってから断られない）
      imageMaxBytes: (maxBytes >= 200 * 1024 && maxBytes < MAX_IMAGE_BYTES) ? maxBytes : MAX_IMAGE_BYTES,
      items: [], stores: [], build: cleanText(c.build, 60)
    };
    var seen = {};
    (Array.isArray(c.items) ? c.items : []).forEach(function (it) {
      if (!it || typeof it !== 'object' || out.items.length >= MAX_ITEMS) return;
      var no = toInt(it.no);
      if (!(no >= 1 && no <= 999) || seen[no]) return;
      var kind = (it.kind === 'date') ? 'date' : (it.kind === 'method' ? 'method' : '');
      if (!kind) return;
      var dates = [];
      (Array.isArray(it.dates) ? it.dates : []).forEach(function (d) {
        var nd = normalizeDate(d);
        if (nd && dates.indexOf(nd) < 0 && dates.length < 14) dates.push(nd);
      });
      var status = (it.status === 'soldout' || it.status === 'needcall') ? it.status : 'normal';
      seen[no] = true;
      out.items.push({ no: no, kind: kind, dates: dates, status: status, name: cleanText(it.name, 30) });
    });
    out.items.sort(function (a, b) { return a.no - b.no; });
    (Array.isArray(c.stores) ? c.stores : []).forEach(function (s) {
      var n = cleanText(s, LIMITS.store);
      if (n && out.stores.indexOf(n) < 0 && out.stores.length < 300) out.stores.push(n);
    });
    return out;
  }
  function buildIndex(cfg) {
    var idx = { byNo: {}, methodNos: [], dateNos: [], soldout: [], needcall: [] };
    cfg.items.forEach(function (it) {
      idx.byNo[it.no] = it;
      (it.kind === 'method' ? idx.methodNos : idx.dateNos).push(it.no);
      if (it.status === 'soldout') idx.soldout.push(it.no);
      if (it.status === 'needcall') idx.needcall.push(it.no);
    });
    return idx;
  }
  function statusOf(idx, no) { var it = idx && idx.byNo[no]; return it ? it.status : 'normal'; }

  // ---- 入力の形（作りかけにも、送る注文にも使う） ----
  //   items[no]     = { storeQty, deliveryQty }（文字のまま。送るときに数にする）
  //   dateItems[no] = { sel: { '12/30': '2', '1/2': '' }（選んだお渡し日 → その日の個数）, hint: '3'（用紙の個数・日付が読めなかったとき。送らない） }
  function emptyForm(idx) {
    var f = { store: '', pickupTime: '', receptionist: '', receiver: emptyParty(), requester: emptyParty(), items: {}, dateItems: {} };
    idx.methodNos.forEach(function (no) { f.items[no] = { storeQty: '', deliveryQty: '' }; });
    idx.dateNos.forEach(function (no) { f.dateItems[no] = { sel: {}, hint: '' }; });
    return f;
  }
  function hasOwn(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  /** 選んだお渡し日（候補の並び＝用紙の並び） */
  function selectedDates(di, dates) { return (dates || []).filter(function (d) { return di && hasOwn(di.sel, d); }); }
  /** 日付を欄の名前に使う形（12/30 → 12-30） */
  function dateToken(d) { return str(d).replace('/', '-'); }
  function dateQtyKey(no, d) { return 'dateItems.' + no + '.q.' + dateToken(d); }
  /** お渡し日のボタンの並び（欄の名前） */
  function dateGroupKey(no) { return 'dateItems.' + no + '.dates'; }
  /** 選んだ日ごとの個数の合計（数として読めるものだけ） */
  function dateTotal(di, dates) {
    var t = 0;
    selectedDates(di, dates).forEach(function (d) { var q = parseQty(di.sel[d]); if (q.value) t += q.value; });
    return t;
  }
  /**
   * 日付型の商品の「注文数」（用紙の個数欄。読み取れたら入り、人が直せる。2026-10-29 PO: 数が空なのに日付の欄が押せると間違って押す
   *   → 注文数を入れるまで、お渡し日は押せない）。形は parseQty と同じ。持ち方は dateItems[no].hint（前の版の作りかけと同じ名前）
   */
  function dateOrderQty(di) { return parseQty(di && di.hint); }
  /** 注文数の欄の名前 */
  function dateOrderKey(no) { return 'dateItems.' + no + '.total'; }
  /**
   * 送る・数える日ごとの個数: 注文数が空 → 無し（日付が選ばれていても送らない＝間違って送られない側）／
   *   選んだ日が1つ → その日に注文数／2つ以上 → 日ごとに入れた個数
   */
  function effectiveDateQtys(di, dates) {
    var t = dateOrderQty(di);
    if (!t.value) return [];
    var sel = selectedDates(di, dates);
    if (sel.length === 1) return [{ d: sel[0], q: t.value }];
    return sel.map(function (d) { return { d: d, q: parseQty(di.sel[d]).value || 0 }; }).filter(function (x) { return x.q; });
  }
  /** 選んだ日が1つなら、その日の個数を注文数にそろえる（日ごとの個数の欄は出さない） */
  function syncSingleDate(di, dates) {
    var sel = selectedDates(di, dates), t = dateOrderQty(di);
    if (sel.length === 1) di.sel[sel[0]] = t.value ? String(t.value) : '';
  }
  /** 作りかけ・修正の注文で注文数が空のとき、日ごとの個数の合計を注文数にする（前の版の作りかけ・窓口の注文に注文数の欄は無い） */
  function fillOrderQtyFromDates(di, dates) {
    if (!di || str(di.hint).trim()) return;
    var t = dateTotal(di, dates);
    if (t) di.hint = String(t);
  }
  function cleanParty(p, multilineAddress) {
    p = (p && typeof p === 'object') ? p : {};
    return {
      name: cleanText(p.name, LIMITS.name),
      zip: cleanText(p.zip, LIMITS.zip + 4),
      address: cleanText(p.address, LIMITS.address, multilineAddress),
      tel: cleanText(p.tel, LIMITS.tel + 4)
    };
  }
  /**
   * AI の読み取り結果を入力の形にする。番号は商品設定にあるものだけ。
   * 返り値: { form, dropped:[番号]（商品設定に無い・種類が違う番号）, storeName }
   */
  function formFromParsed(parsed, idx) {
    parsed = (parsed && typeof parsed === 'object') ? parsed : {};
    var form = emptyForm(idx), dropped = [];
    form.pickupTime = cleanText(parsed.pickupTime, LIMITS.pickupTime);
    form.receptionist = cleanText(parsed.receptionist, LIMITS.receptionist) || RECEPTIONIST_NONE;   // 読めなければ「記載なし」（画面で直せる）
    form.receiver = cleanParty(parsed.receiver);
    form.requester = cleanParty(parsed.requester);
    // 2026-10-16 に items21_32 → datedItems へ改名（古い名前で返る窓口にも合わせる）
    var dated = Array.isArray(parsed.datedItems) ? parsed.datedItems : (Array.isArray(parsed.items21_32) ? parsed.items21_32 : []);
    var all = [].concat(Array.isArray(parsed.items) ? parsed.items.slice(0, 80) : [], dated.slice(0, 80));
    all.forEach(function (it) {
      if (!it || typeof it !== 'object') return;
      var no = toInt(it.no);
      if (!(no >= 1)) return;
      var meta = idx.byNo[no];
      var q = parseQty(it.qty), qs = parseQty(it.storeQty), qd = parseQty(it.deliveryQty);
      if (!meta) { if ((q.value || qs.value || qd.value) && dropped.indexOf(no) < 0) dropped.push(no); return; }
      if (meta.kind === 'method') {
        // 追補 v2: 店渡しの数と宅配の数を別々に読む。古い形（qty＋method）で返る窓口にも合わせる
        if (qs.value) form.items[no].storeQty = String(qs.value);
        if (qd.value) form.items[no].deliveryQty = String(qd.value);
        if (q.value && it.method === 'store' && !qs.value) form.items[no].storeQty = String(q.value);
        if (q.value && it.method === 'delivery' && !qd.value) form.items[no].deliveryQty = String(q.value);
      } else {
        // 追補 v3: お渡し日は複数あってよい。○が複数なら窓口は個数 0 で返す（日ごとの個数は人が入れる）。
        //   日付が候補に無い・読めないときは、個数だけを「用紙の個数」として見せる（日付は決めない）
        var di = form.dateItems[no];
        var d = normalizeDate(it.pickupDate, meta.dates);
        if (d) {
          if (!hasOwn(di.sel, d)) di.sel[d] = q.value ? String(q.value) : '';
          else if (!di.sel[d] && q.value) di.sel[d] = String(q.value);
        } else if (q.value && !di.hint) {
          di.hint = String(q.value);
        }
      }
    });
    // 注文数（用紙の個数）: 日付と個数が読めたら、その個数（○が複数で個数 0 のときは、窓口の formQty を startReviewFromOcr が入れる）
    idx.dateNos.forEach(function (no) { fillOrderQtyFromDates(form.dateItems[no], idx.byNo[no].dates); });
    return { form: form, dropped: dropped, storeName: cleanText(parsed.storeName, LIMITS.store) };
  }
  /** 窓口の注文（getOrder の order）→ 入力の形（修正の画面）。番号・日付は今の商品設定にあるものだけ */
  function formFromOrder(o, idx) {
    o = (o && typeof o === 'object') ? o : {};
    var form = emptyForm(idx);
    form.store = cleanText(o.store, LIMITS.store);
    form.pickupTime = cleanText(o.pickupTime, LIMITS.pickupTime);
    form.receptionist = cleanText(o.receptionist, LIMITS.receptionist) || RECEPTIONIST_NONE;
    form.receiver = cleanParty(o.receiver, true);
    form.requester = cleanParty(o.requester, true);
    (Array.isArray(o.items) ? o.items : []).slice(0, 80).forEach(function (it) {
      var no = toInt(it && it.no);
      if (!form.items[no]) return;
      var a = parseQty(it.storeQty).value, b = parseQty(it.deliveryQty).value;
      form.items[no] = { storeQty: a ? String(a) : '', deliveryQty: b ? String(b) : '' };
    });
    (Array.isArray(o.datedItems) ? o.datedItems : []).slice(0, 80).forEach(function (it) {
      var no = toInt(it && it.no), di = form.dateItems[no];
      if (!di) return;
      var d = normalizeDate(it.pickupDate, idx.byNo[no].dates), q = parseQty(it.qty).value;
      if (d && q) di.sel[d] = String(q);
    });
    idx.dateNos.forEach(function (no) { fillOrderQtyFromDates(form.dateItems[no], idx.byNo[no].dates); });
    return form;
  }
  /** 直す前の数量（売り切れ・要電話確認は、増えた分だけを見るため）{ m:{no:{s,d}}, d:{'no@12/30':q} } */
  function baselineOf(o) {
    var b = { m: {}, d: {} };
    (Array.isArray(o && o.items) ? o.items : []).forEach(function (it) {
      var no = toInt(it && it.no);
      if (no >= 1) b.m[no] = { s: parseQty(it.storeQty).value || 0, d: parseQty(it.deliveryQty).value || 0 };
    });
    (Array.isArray(o && o.datedItems) ? o.datedItems : []).forEach(function (it) {
      var no = toInt(it && it.no), d = normalizeDate(it && it.pickupDate);
      if (no >= 1 && d) b.d[no + '@' + d] = parseQty(it.qty).value || 0;
    });
    return b;
  }
  /** お客様リストの部品のアドレス（この osechi.js と同じ場所・同じ版）。分からなければ '' */
  function listModuleUrl(selfSrc, build) {
    var m = str(selfSrc).match(/^(https?:\/\/[^?#]*\/)osechi\.js(?:[?#].*)?$/);
    return m ? m[1] + 'osechi_list.js?v=' + encodeURIComponent(build) : '';
  }
  /** 作りかけ（端末に残したもの）も信用せず、今の商品設定に合わせて読み直す */
  function formFromDraft(df, idx) {
    df = (df && typeof df === 'object') ? df : {};
    var form = emptyForm(idx);
    form.pickupTime = cleanText(df.pickupTime, LIMITS.pickupTime);
    form.receptionist = cleanText(df.receptionist, LIMITS.receptionist) || RECEPTIONIST_NONE;   // 前の版の作りかけには無い
    form.receiver = cleanParty(df.receiver, true);
    form.requester = cleanParty(df.requester, true);
    idx.methodNos.forEach(function (no) {
      var it = df.items && df.items[no];
      if (!it) return;
      form.items[no].storeQty = cleanText(it.storeQty, 3);
      form.items[no].deliveryQty = cleanText(it.deliveryQty, 3);
    });
    idx.dateNos.forEach(function (no) {
      var it = df.dateItems && df.dateItems[no];
      if (!it || typeof it !== 'object') return;
      var dates = idx.byNo[no].dates, di = form.dateItems[no];
      if (it.sel && typeof it.sel === 'object') {
        Object.keys(it.sel).slice(0, 14).forEach(function (k) {
          var d = normalizeDate(k, dates);
          if (d) di.sel[d] = cleanText(it.sel[k], 3);
        });
      } else if (it.date) {   // 2026-10-16 夕より前の作りかけ（1つの日付と個数）
        var d0 = normalizeDate(it.date, dates);
        if (d0) di.sel[d0] = cleanText(it.qty, 3);
      }
      di.hint = cleanText(it.hint, 3);
      fillOrderQtyFromDates(di, dates);   // 2026-10-29 より前の作りかけ（注文数の欄が無い）
    });
    return form;
  }
  /**
   * 欄の値を名前で読む・書く。名前の形:
   *   pickupTime / store / receiver.name … / items.<no>.storeQty|deliveryQty / dateItems.<no>.q.<12-30>
   */
  function getField(form, key) {
    var p = str(key).split('.');
    if (!form) return '';
    if (p.length === 1) return str(form[p[0]]);
    if (p[0] === 'items' && p.length === 3) return str(form.items[p[1]] && form.items[p[1]][p[2]]);
    if (p[0] === 'dateItems' && p.length === 3 && p[2] === 'total') return str(form.dateItems[p[1]] && form.dateItems[p[1]].hint);
    if (p[0] === 'dateItems' && p.length === 4 && p[2] === 'q') {
      var di = form.dateItems[p[1]], d = str(p[3]).replace('-', '/');
      return di && hasOwn(di.sel, d) ? str(di.sel[d]) : '';
    }
    return str(form[p[0]] && form[p[0]][p[1]]);
  }
  function setField(form, key, value) {
    var p = str(key).split('.');
    if (p.length === 1) { form[p[0]] = value; return; }
    if (p[0] === 'items' && p.length === 3) { if (form.items[p[1]]) form.items[p[1]][p[2]] = value; return; }
    if (p[0] === 'dateItems' && p.length === 3 && p[2] === 'total') { if (form.dateItems[p[1]]) form.dateItems[p[1]].hint = value; return; }
    if (p[0] === 'dateItems' && p.length === 4 && p[2] === 'q') {
      var di = form.dateItems[p[1]], d = str(p[3]).replace('-', '/');
      if (di && hasOwn(di.sel, d)) di.sel[d] = value;
      return;
    }
    if (form[p[0]] && typeof form[p[0]] === 'object') form[p[0]][p[1]] = value;
  }
  function copyParty(form, from, to) { PARTY_FIELDS.forEach(function (f) { form[to][f] = str(form[from][f]); }); }

  function validateFieldFormats(form) {
    var errs = [];
    ['receiver', 'requester'].forEach(function (side) {
      var p = form[side];
      p.tel = normalizeTel(p.tel);
      p.zip = normalizeZip(p.zip);
      if (trim(p.name).length > LIMITS.name) errs.push({ key: side + '.name', message: SIDE_LABEL[side] + 'の氏名は ' + LIMITS.name + ' 文字までです' });
      if (cleanText(p.address, 0).length > LIMITS.address) errs.push({ key: side + '.address', message: SIDE_LABEL[side] + 'の住所は ' + LIMITS.address + ' 文字までです' });
      if (!isValidTel(p.tel)) errs.push({ key: side + '.tel', message: SIDE_LABEL[side] + 'の電話番号は、数字とハイフンで入れてください（20文字まで）' });
      if (!isValidZip(p.zip)) errs.push({ key: side + '.zip', message: SIDE_LABEL[side] + 'の郵便番号は「123-4567」の形で入れてください' });
    });
    if (trim(form.pickupTime).length > LIMITS.pickupTime) errs.push({ key: 'pickupTime', message: '受取時間は ' + LIMITS.pickupTime + ' 文字までです' });
    return errs;
  }

  /** 空のままの必須の欄（2026 計画書: 宅配＝両方の4欄・店渡し＝ご依頼主の電話）。キーの一覧を返す */
  function findMissing(form, hasStore, hasDelivery) {
    var miss = [];
    if (hasDelivery) {
      ['receiver', 'requester'].forEach(function (side) {
        PARTY_FIELDS.forEach(function (f) { if (!trim(form[side][f])) miss.push(side + '.' + f); });
      });
    } else if (hasStore) {
      if (!trim(form.requester.tel)) miss.push('requester.tel');
    }
    return miss;
  }
  function labelOfKey(key) {
    var p = str(key).replace(/^order\./, '').split('.');
    if (p.length === 2 && SIDE_LABEL[p[0]]) return SIDE_LABEL[p[0]] + 'の' + (PARTY_LABEL[p[1]] || p[1]);
    if (key === 'pickupTime') return 'お引取り時間';
    if (key === 'store') return '店舗名';
    if (key === 'receptionist') return '受付係員';
    return str(key);
  }

  /**
   * 送る前の確かめ（昨年の applyButton の処理を同じ順で引き継ぐ。追補 v2・v3 に合わせて直した所は注記）。
   * form を書き換える（同上の補完・コピー・移動）。ui.alert / ui.confirm / ui.choose は Promise を返す。
   * 返り値: { ok:false } または { ok:true, needCallNos:[], missing:[キー], hasStore, hasDelivery, confirmedCodes:[窓口の注意の種類] }
   *   confirmedCodes … ここで人が確かめ済みの注意（宅配とお引取り時間＝PICKUP_TIME_WITH_DELIVERY）。窓口が同じ注意を返しても二度は聞かない
   */
  async function runPreSubmitChecks(form, env, ui) {
    var idx = env.idx;
    applySameWordAutofill(form);
    var bad = [], badKey = '', noDate = [], noQty = [], noTotal = [], soldout = [], needcall = [], hintDiff = [], confirmedCodes = [];
    var hasStore = false, hasDelivery = false, count = 0;
    // 修正（env.baseline＝直す前の注文）: 売り切れ・要電話確認は、数量が増えた商品だけを見る（売り切れのあとに住所だけ直せるように）
    var base = env.baseline || null;
    function grewM(no, a, b) { if (!base) return true; var o = base.m[no] || { s: 0, d: 0 }; return a > o.s || b > o.d; }
    function grewD(no, it, dates) { if (!base) return true; return selectedDates(it, dates).some(function (d) { return (parseQty(it.sel[d]).value || 0) > (base.d[no + '@' + d] || 0); }); }
    idx.methodNos.forEach(function (no) {
      // 追補 v2: 1つの商品に店渡しの数と宅配の数（どちらか・両方）。昨年の「受取方法の選び忘れ」は起きない形
      var it = form.items[no], qs = parseQty(it.storeQty), qd = parseQty(it.deliveryQty);
      if (qs.error || qd.error) { bad.push(no); if (!badKey) badKey = 'items.' + no + (qs.error ? '.storeQty' : '.deliveryQty'); return; }
      if (!qs.value && !qd.value) return;
      count++;
      if (qs.value) hasStore = true;
      if (qd.value) hasDelivery = true;
      var grew = grewM(no, qs.value || 0, qd.value || 0);
      if (statusOf(idx, no) === 'soldout' && grew) soldout.push(no);
      if (statusOf(idx, no) === 'needcall' && grew) needcall.push(no);
    });
    idx.dateNos.forEach(function (no) {
      // 2026-10-29: 注文数（用紙の個数）→ お渡し日（いくつでも）→ 2日以上なら日ごとの個数（追補 v3）。
      //   注文数が空なら送らない。日付だけ選ばれていたら止める（読み取りで日付だけ読めた行・間違って押した日付を、黙って送らない／捨てない）
      var it = form.dateItems[no], dates = idx.byNo[no].dates, sel = selectedDates(it, dates), tq = dateOrderQty(it), rowBad = false, empties = [];
      if (tq.error) { bad.push(no); if (!badKey) badKey = dateOrderKey(no); return; }
      if (!tq.value) { if (sel.length) noTotal.push({ no: no, dates: sel }); return; }
      if (!sel.length) { noDate.push(no); return; }
      if (sel.length === 1) syncSingleDate(it, dates);
      if (sel.length > 1) {
        sel.forEach(function (d) {
          var q = parseQty(it.sel[d]);
          if (q.error) { rowBad = true; if (!badKey) badKey = dateQtyKey(no, d); return; }
          if (q.empty) empties.push(d);
        });
      }
      if (rowBad) { bad.push(no); return; }
      if (empties.length) { noQty.push({ no: no, dates: empties }); return; }
      count++;
      hasStore = true;   // お渡し日を選ぶ商品は店渡し（2026 様式「店渡し日」）。受取時間・お届け先の決まりでは店渡しとして数える
      if (sel.length > 1 && dateTotal(it, dates) !== tq.value) hintDiff.push({ no: no, hint: tq.value, total: dateTotal(it, dates) });
      var grewd = grewD(no, it, dates);
      if (statusOf(idx, no) === 'soldout' && grewd) soldout.push(no);
      if (statusOf(idx, no) === 'needcall' && grewd) needcall.push(no);
    });
    function fail(key) { if (key && ui.focus) ui.focus(key); return { ok: false }; }

    if (bad.length) {
      await ui.alert('数量は 1〜99 の数字で入れてください。\n対象の商品: ' + bad.join(', '), badKey || qtyKey(idx, bad[0], form));
      return { ok: false };
    }
    if (noTotal.length) {
      await ui.alert('お渡し日は選ばれていますが、注文数が空の商品があります。\n対象: ' +
        noTotal.map(function (x) { return '商品' + x.no + '（' + x.dates.join('・') + '）'; }).join('、') +
        '\n注文書の個数を確かめて「注文数」に入れてください（空のままは送れません）。\n注文しないときは、その行の「日付を外す（この商品は受注なし）」を押してください。',
        dateOrderKey(noTotal[0].no));
      return { ok: false };
    }
    if (noQty.length) {
      await ui.alert('お渡し日を選んだのに、その日の個数が入っていません。\n対象: ' +
        noQty.map(function (x) { return '商品' + x.no + '（' + x.dates.join('・') + '）'; }).join('、') +
        '\n用紙の個数欄は1つなので、日ごとの個数をお客様に確かめて入れてください（空のままは送れません）。',
        dateQtyKey(noQty[0].no, noQty[0].dates[0]));
      return { ok: false };
    }
    if (noDate.length) {
      await ui.alert('注文数は入っていますが、お渡し日が選ばれていない商品があります。\n対象の商品: ' +
        noDate.join(', ') + '\nお渡し日を押して選んでください（2日以上なら、日ごとの個数も入れます）。', dateGroupKey(noDate[0]));
      return { ok: false };
    }
    if (!count) {
      await ui.alert('数量の入った商品がありません。\n注文書と見比べて、数量を入れてください。',
        idx.methodNos.length ? 'items.' + idx.methodNos[0] + '.storeQty' : (idx.dateNos.length ? dateGroupKey(idx.dateNos[0]) : ''));
      return { ok: false };
    }
    if (soldout.length) {
      await ui.alert('商品 ' + soldout.join(', ') + ' は「売り切れ」です。\nこの商品は受注できません。数量を消してください。',
        qtyKey(idx, soldout[0], form));
      return { ok: false };
    }
    // 追補 v3: 注文数（用紙の個数）と、日ごとの個数の合計が違う → 確かめる（止めない）
    if (hintDiff.length) {
      if (!await ui.confirm('注文数と、日ごとの個数の合計が違います。\n' +
        hintDiff.map(function (x) { return '商品' + x.no + '：注文数 ' + x.hint + ' 個 ／ 日ごとの合計 ' + x.total + ' 個'; }).join('\n') +
        '\nお客様に確かめた数なら、このまま進めてください。', { yes: 'このまま進む', no: '戻って直す' })) return fail(dateGroupKey(hintDiff[0].no));
    }

    // 受取時間と、店渡し／宅配
    //   追補 v2 §11-4: 宅配だけの注文に受取時間 → 止めずに確かめる（宅配は時間指定ができない旨をお客様へ）
    var pt = trim(form.pickupTime);
    if (pt && hasDelivery && !hasStore) {
      var a = ui.choose ? await ui.choose('お引取り時間が入っていますが、商品がすべて「宅配」です。\n宅配では時間を指定できません（お客様にお伝えください）。',
        [{ id: 'clear', label: 'お引取り時間を消して進む', kind: 'primary' }, { id: 'keep', label: 'このまま進む', kind: 'secondary' }, { id: 'back', label: '戻って直す', kind: 'secondary' }], 'back')
        : (await ui.confirm('お引取り時間が入っていますが、商品がすべて「宅配」です。\nお引取り時間を消して進みますか？', { yes: 'お引取り時間を消して進む', no: '戻って直す' }) ? 'clear' : 'back');
      if (a === 'back') return fail('pickupTime');
      if (a === 'clear') { form.pickupTime = ''; if (ui.changed) ui.changed(); }
      else confirmedCodes.push('PICKUP_TIME_WITH_DELIVERY');
    }
    if (pt && hasDelivery && hasStore) {
      if (!await ui.confirm('宅配では時間を指定できません。\n店渡しの分のお引取り時間として送ってよろしいですか？',
        { yes: '店渡しのお引取り時間として進む', no: '戻って直す' })) return fail('pickupTime');
      confirmedCodes.push('PICKUP_TIME_WITH_DELIVERY');
    }

    // お届け先・ご依頼主と、店渡し／宅配
    if (hasDelivery && !hasAnyInfo(form.receiver)) {
      if (!await ui.confirm('お届け先が空欄なのに「宅配」の数が入っています。\n\nご依頼主の情報を、お届け先にコピーして進めてよろしいですか？',
        { yes: 'ご依頼主をお届け先にコピーする', no: '戻って直す' })) return fail('receiver.name');
      copyParty(form, 'requester', 'receiver');
      if (ui.changed) ui.changed();
    }
    var hasRec = hasAnyInfo(form.receiver), hasReq = hasAnyInfo(form.requester);
    if (hasStore && !hasDelivery && hasRec && !hasReq) {
      if (!await ui.confirm('店渡しの注文ですが、ご依頼主が空欄で、お届け先だけが入っています。\n\nお届け先の情報をご依頼主へ移し、お届け先を空欄にしてよろしいですか？',
        { yes: 'ご依頼主へ移す', no: '戻って直す' })) return fail('requester.name');
      PARTY_FIELDS.forEach(function (f) { form.requester[f] = trim(form.receiver[f]); form.receiver[f] = ''; });
      if (ui.changed) ui.changed();
      hasRec = hasAnyInfo(form.receiver); hasReq = hasAnyInfo(form.requester);
    }
    if (hasDelivery && hasRec && !hasReq) {
      if (!await ui.confirm('宅配の注文ですが、ご依頼主が空欄です。\n\nお届け先の情報を、ご依頼主にもコピーして進めてよろしいですか？',
        { yes: 'お届け先をご依頼主にコピーする', no: '戻って直す' })) return fail('requester.name');
      copyParty(form, 'receiver', 'requester');
      if (ui.changed) ui.changed();
      hasRec = hasAnyInfo(form.receiver); hasReq = hasAnyInfo(form.requester);
    }
    if (hasRec && hasReq && hasStore) {
      if (!hasDelivery) {
        await ui.alert('お届け先とご依頼主の両方が入っていますが、「宅配」の数が入った商品がありません。\nこのままでは受注できません。店渡しの数・宅配の数を確かめてください。',
          idx.methodNos.length ? 'items.' + idx.methodNos[0] + '.deliveryQty' : '');
        return { ok: false };
      }
      if (!await ui.confirm('お届け先とご依頼主の両方が入っていて、「店渡し」の商品もあります。\n\n宅配の商品を含む注文として送ってよろしいですか？',
        { yes: 'このまま進む', no: '戻って直す' })) return fail('');
    }

    // 欄の形（文字数・電話・郵便番号）
    var fe = validateFieldFormats(form);
    if (ui.changed) ui.changed();
    if (fe.length) {
      await ui.alert(fe.map(function (e) { return '・' + e.message; }).join('\n'), fe[0].key);
      return { ok: false };
    }
    // 宅配はお届け先の氏名と住所が無いと届けられない（ここは「このまま送る」を出さない）
    if (hasDelivery && (!trim(form.receiver.name) || !trim(form.receiver.address))) {
      await ui.alert('宅配の商品があるのに、お届け先の氏名か住所が空欄です。\nお届け先の氏名と住所を入れてください。',
        !trim(form.receiver.name) ? 'receiver.name' : 'receiver.address');
      return { ok: false };
    }
    return { ok: true, needCallNos: needcall, missing: findMissing(form, hasStore, hasDelivery), hasStore: hasStore, hasDelivery: hasDelivery, confirmedCodes: confirmedCodes };
  }
  /** 商品の数量の欄の名前（知らせたあとに、そこへ動かすため） */
  function qtyKey(idx, no, form) {
    var meta = idx.byNo[no];
    if (meta && meta.kind === 'date') {
      var di = form && form.dateItems && form.dateItems[no];
      var sel = selectedDates(di, meta.dates);
      if (!dateOrderQty(di).value) return dateOrderKey(no);   // 注文数が先
      return sel.length > 1 ? dateQtyKey(no, sel[0]) : (sel.length ? dateOrderKey(no) : dateGroupKey(no));
    }
    var it = form && form.items && form.items[no];
    var useDelivery = it && !trim(it.storeQty) && trim(it.deliveryQty);
    return 'items.' + no + (useDelivery ? '.deliveryQty' : '.storeQty');
  }

  /** 窓口へ送る注文（SPEC §4・追補 v3 §19 の形）。method 型は items、date 型は datedItems（日付ごとに1つ） */
  function buildOrder(form, env) {
    var o = {
      store: env.role === 'hq' ? cleanText(form.store, LIMITS.store) : cleanText(env.store, LIMITS.store),
      pickupTime: cleanText(form.pickupTime, LIMITS.pickupTime),
      receptionist: cleanText(form.receptionist, LIMITS.receptionist) || RECEPTIONIST_NONE,
      receiver: orderParty(form.receiver),
      requester: orderParty(form.requester),
      items: [], datedItems: []
    };
    env.idx.methodNos.forEach(function (no) {
      var it = form.items[no], qs = parseQty(it.storeQty).value || 0, qd = parseQty(it.deliveryQty).value || 0;
      if (qs || qd) o.items.push({ no: no, storeQty: qs, deliveryQty: qd });
    });
    env.idx.dateNos.forEach(function (no) {
      // 注文数が空なら送らない・日付が1つなら注文数・2つ以上なら日ごとの個数（effectiveDateQtys）
      effectiveDateQtys(form.dateItems[no], env.idx.byNo[no].dates).forEach(function (x) {
        o.datedItems.push({ no: no, pickupDate: x.d, qty: x.q });
      });
    });
    return o;
  }
  /** 窓口の注意（flags.warnings: {code, message, item?}）。文字と種類と番号だけを取り出す（同じ文は1つ） */
  function cleanWarnings(arr) {
    var out = [];
    (Array.isArray(arr) ? arr : []).slice(0, 30).forEach(function (w) {
      var msg = cleanText(w && typeof w === 'object' ? w.message : w, 200);
      if (!msg) return;
      var no = (w && typeof w === 'object') ? toInt(w.item != null ? w.item : w.no) : NaN;
      var code = (w && typeof w === 'object' && /^[A-Z][A-Z0-9_]{0,39}$/.test(str(w.code))) ? str(w.code) : '';
      if (!out.some(function (x) { return x.message === msg; })) out.push({ message: msg, no: no >= 1 ? no : null, code: code });
    });
    return out;
  }
  /**
   * 窓口の読み取りの注意 DATE_QTY_NEEDED に付く「用紙の個数」（formQty）を、商品番号ごとに取り出す（1〜99 の整数だけ）。
   * 窓口は○が複数のとき日ごとの個数を 0 で返し、用紙の個数はこの注意にだけ載せる（gas/Gemini.gs ocrDatedItems_）
   */
  function formQtyByItem(arr) {
    var out = {};
    (Array.isArray(arr) ? arr : []).slice(0, 30).forEach(function (w) {
      if (!w || typeof w !== 'object' || w.code !== 'DATE_QTY_NEEDED') return;
      var no = toInt(w.item), q = toInt(w.formQty);
      if (no >= 1 && q >= 1 && q <= 99) out[no] = q;
    });
    return out;
  }
  /** 確認では越えられない注意があるか（DATE_QTY_NEEDED） */
  function hasBlockingWarning(warns) { return (warns || []).some(function (w) { return !!BLOCKING_WARNINGS[w.code]; }); }
  /**
   * 窓口の欄の名前（order.receiver.name・order.items[2].storeQty・order.datedItems[1].qty …）を画面の欄の名前にする。
   * 番号は送った注文から引く（並びの番号を商品番号と取り違えない）。分からなければ ''。
   */
  function serverFieldToKey(field, order) {
    var f = cleanText(field, 80).replace(/^order\./, '');
    var m;
    if (/^(receiver|requester)\.(name|zip|address|tel)$/.test(f) || f === 'pickupTime' || f === 'store' || f === 'receptionist') return f;
    if ((m = f.match(/^items\[(\d{1,2})\]\.(storeQty|deliveryQty)$/))) {
      var it = order && order.items && order.items[Number(m[1])];
      return it ? 'items.' + it.no + '.' + m[2] : '';
    }
    if ((m = f.match(/^datedItems\[(\d{1,2})\]\.(qty|pickupDate)$/))) {
      var dt = order && order.datedItems && order.datedItems[Number(m[1])];
      if (!dt) return '';
      return m[2] === 'qty' ? dateQtyKey(dt.no, dt.pickupDate) : dateGroupKey(dt.no);
    }
    return '';
  }
  function orderParty(p) {
    return {
      name: cleanText(isSameWord(p.name) ? '' : p.name, LIMITS.name),
      zip: normalizeZip(isSameWord(p.zip) ? '' : p.zip),
      address: cleanText(isSameWord(p.address) ? '' : p.address, LIMITS.address),
      tel: normalizeTel(isSameWord(p.tel) ? '' : p.tel)
    };
  }
  function fingerprint(order) { try { return JSON.stringify(order); } catch (e) { return ''; } }

  // ---- 窓口のアドレス・番号・失敗の種類 ----
  /** 窓口のアドレスは許可した形だけ（本番の GAS／試験用の自分の PC）。プレースホルダのままなら使わない */
  function isAllowedApiUrl(u) {
    u = str(u);
    if (/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{10,200}\/exec$/.test(u)) return true;
    if (/^http:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}\/[A-Za-z0-9_\/-]{0,100}$/.test(u)) return true;
    return false;
  }
  function makeSubmissionId(cryptoObj) {
    var c = cryptoObj || root.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    var b = new Array(16), i;
    if (c && typeof c.getRandomValues === 'function') {
      var u = new Uint8Array(16); c.getRandomValues(u);
      for (i = 0; i < 16; i++) b[i] = u[i];
    } else {
      for (i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    }
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = b.map(function (x) { return (x + 0x100).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  /** やり直しても変わらない断りか（＝その送信は保存されていないと分かっている） */
  var DEFINITIVE = { BAD_REQUEST: 1, FORBIDDEN: 1, AUTH_DENIED: 1, SOLD_OUT: 1, NEED_CALL_UNCONFIRMED: 1, CLOSED: 1, NOT_FOUND: 1, RATE_LIMITED: 1, SUMARECO_LOGIN: 1, CONFIG: 1, NEEDS_CONFIRM: 1, CONFLICT: 1, NOT_READY: 1 };
  function isDefinitive(code) { return !!DEFINITIVE[code]; }
  var DEFAULT_MESSAGES = {
    AUTH_REQUIRED: 'ログインの確認ができませんでした。スマレコにログインし直してから、もう一度開いてください。',
    SUMARECO_LOGIN: 'スマレコのログインが切れています。スマレコにログインし直してから、もう一度開いてください。',
    AUTH_DENIED: 'おせち受注は、店舗のアカウント・店長・本部（許可リストに登録された方）が使えます。このアカウントでは使えません。',
    FORBIDDEN: 'この操作はできません（ほかの店の注文などです）。',
    BAD_REQUEST: '入力の内容を確かめてください。',
    BUSY: '混み合っています。少し待ってから、もう一度お試しください。',
    RATE_LIMITED: '読み取りの回数が上限に達しました。しばらくしてから、もう一度お試しください。',
    CLOSED: '受付期間の外です。注文を受け付けられません。',
    SOLD_OUT: '売り切れの商品が含まれています。',
    NEED_CALL_UNCONFIRMED: '要電話確認の商品があります。お客様に電話で確かめてから送ってください。',
    NOT_FOUND: 'この注文は見つかりません（取り消された・ほかの店の注文など）。',
    NEEDS_CONFIRM: '確認が要る点があります。',
    CONFLICT: 'ほかの人が先にこの注文を直しました。もう一度「この内容で送信」を押してください。',
    NOT_READY: 'この機能は準備中です。',
    SERVER_ERROR: '窓口でエラーが起きました。少し待ってから、もう一度お試しください。',
    NETWORK: '通信できませんでした。電波の良い所で、もう一度お試しください。',
    TIMEOUT: '時間内に返事がありませんでした。電波の良い所で、もう一度お試しください。',
    CONFIG: 'おせち受注の窓口がまだ設定されていません。管理者にお知らせください。'
  };
  function OsechiError(code, message, retry, extra) {
    this.code = code || 'SERVER_ERROR';
    this.message = cleanText(message, 300) || DEFAULT_MESSAGES[this.code] || DEFAULT_MESSAGES.SERVER_ERROR;
    this.retry = !!retry;
    if (extra) { this.field = cleanText(extra.field, 60); this.missing = extra.missing; this.warnings = extra.warnings; }
  }
  OsechiError.prototype = Object.create(Error.prototype);
  OsechiError.prototype.name = 'OsechiError';

  function sanitizeMe(me) {
    if (!me || typeof me !== 'object') return null;
    var role = me.role;
    if (role !== 'store' && role !== 'lead' && role !== 'hq') return null;
    var stores = [];
    (Array.isArray(me.stores) ? me.stores : []).forEach(function (s) {
      var n = cleanText(s, LIMITS.store); if (n && stores.indexOf(n) < 0 && stores.length < 300) stores.push(n);
    });
    var store = cleanText(me.store, LIMITS.store);
    if (role !== 'hq' && !store) return null;   // 店の区分なのに店が無い＝使わない（閉じる側）
    return { email: cleanText(me.email, 120).toLowerCase(), role: role, isAdmin: me.isAdmin === true, store: store, stores: stores };
  }
  /** 空いている必須の欄の一覧（窓口は order.receiver.zip の形・古い形は receiver.zip）。知っている名前だけ */
  function cleanMissing(arr) {
    var out = [];
    (Array.isArray(arr) ? arr : []).slice(0, 20).forEach(function (k) {
      k = cleanText(k, 40).replace(/^order\./, '');
      if (/^(receiver|requester)\.(name|zip|address|tel)$/.test(k) && out.indexOf(k) < 0) out.push(k);
    });
    return out;
  }

  /**
   * 窓口との通信。札は sessionStorage。AUTH_REQUIRED は静かに1回だけ札を取り直して続ける。
   * BUSY は1回だけ間隔を置いて同じ中身で送り直す（送信番号も同じ）。やり直しても変わらない断りは送り直さない。
   * o: { apiUrl, fetch, getSumarecoToken, storage, sleep, expectEmail, expectShop, random }
   */
  function createApi(o) {
    var fetchImpl = o.fetch, storage = o.storage, sleep = o.sleep, rnd = o.random || Math.random;
    var session = null, sessionPromise = null;
    var stats = { calls: 0, reauth: 0, busyRetry: 0, netRetry: 0 };

    function loadStored() {
      try {
        var raw = storage && storage.getItem(SESSION_KEY);
        if (!raw) return null;
        var s = JSON.parse(raw);
        if (!s || typeof s.token !== 'string' || !s.token) return null;
        if (!(Number(s.expiresAt) - 60000 > Date.now())) return null;
        var me = sanitizeMe(s.me);
        if (!me) return null;
        // 別の人の札・所属の変わった札は使わない（同じタブでスマレコの利用者が替わったとき）
        if (o.expectEmail && me.email !== str(o.expectEmail).toLowerCase()) return null;
        if (o.expectShop && me.role !== 'hq' && me.store !== cleanText(o.expectShop, LIMITS.store)) return null;
        return { token: s.token, expiresAt: Number(s.expiresAt), me: me };
      } catch (e) { return null; }
    }
    function store(s) { try { if (storage) storage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) { /* 保存できなくても動く */ } }
    function forget() { session = null; try { if (storage) storage.removeItem(SESSION_KEY); } catch (e) { /* 何もしない */ } }

    async function raw(body, opt) {
      opt = opt || {};
      stats.calls++;
      var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
      var timedOut = false, timer = null, onAbort = null;
      if (ctrl) {
        timer = setTimeout(function () { timedOut = true; ctrl.abort(); }, opt.timeoutMs || 30000);
        if (opt.signal) {
          if (opt.signal.aborted) ctrl.abort();
          onAbort = function () { ctrl.abort(); };
          opt.signal.addEventListener('abort', onAbort);
        }
      }
      var res;
      try {
        res = await fetchImpl(o.apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(body),
          redirect: 'follow', credentials: 'omit', cache: 'no-store',
          signal: ctrl ? ctrl.signal : undefined
        });
      } catch (e) {
        if (opt.signal && opt.signal.aborted) throw new OsechiError('ABORTED', 'やめました', false);
        throw new OsechiError(timedOut ? 'TIMEOUT' : 'NETWORK', '', true);
      } finally {
        if (timer) clearTimeout(timer);
        if (opt.signal && onAbort) opt.signal.removeEventListener('abort', onAbort);
      }
      if (!res || !res.ok) throw new OsechiError(res && res.status >= 500 ? 'SERVER_ERROR' : 'NETWORK', '', true);
      var json;
      try { json = await res.json(); } catch (e) { throw new OsechiError('SERVER_ERROR', '', true); }
      if (!json || typeof json !== 'object') throw new OsechiError('SERVER_ERROR', '', true);
      if (json.ok === true) return json;
      var er = (json.error && typeof json.error === 'object') ? json.error : {};
      throw new OsechiError(cleanText(er.code, 40) || 'SERVER_ERROR', er.message, er.retry === true,
        { field: er.field, missing: er.missing || (json.flags && json.flags.missing), warnings: er.warnings || (json.flags && json.flags.warnings) });
    }

    async function startSession() {
      var smr = '';
      try { smr = str(o.getSumarecoToken()); } catch (e) { smr = ''; }
      if (!smr) throw new OsechiError('SUMARECO_LOGIN', '', false);
      var r;
      for (var attempt = 0; ; attempt++) {
        try {
          r = await raw({ action: 'startSession', sumarecoToken: smr }, { timeoutMs: SESSION_TIMEOUT_MS });
          break;
        } catch (e) {
          if (e.code === 'AUTH_REQUIRED') throw new OsechiError('SUMARECO_LOGIN', '', false);
          if (e.code === 'BUSY' && attempt === 0) { stats.busyRetry++; await sleep(1200 + Math.floor(rnd() * 1300)); continue; }
          throw e;
        }
      }
      var me = sanitizeMe(r.me);
      var exp = Number(r.expiresAt);
      if (typeof r.token !== 'string' || !r.token || r.token.length > 4096 || !me || !isFinite(exp)) {
        throw new OsechiError('SERVER_ERROR', '', true);
      }
      session = { token: r.token, expiresAt: exp, me: me };
      store(session);
      return session;
    }
    async function ensureSession() {
      if (session && session.expiresAt - 60000 > Date.now()) return session;
      if (!session) {
        var s = loadStored();
        if (s) { session = s; return session; }
      }
      if (!sessionPromise) {
        sessionPromise = startSession().then(function (s) { sessionPromise = null; return s; },
          function (e) { sessionPromise = null; throw e; });
      }
      return sessionPromise;
    }

    /** 窓口を呼ぶ。待ち時間・送り直しは ACTION_OPTS の表（opt で上書きできる。signal はやめるための印） */
    async function call(action, payload, extra) {
      var opt = {}, base = ACTION_OPTS[action] || DEFAULT_ACTION_OPTS;
      Object.keys(base).forEach(function (k) { opt[k] = base[k]; });
      Object.keys(extra || {}).forEach(function (k) { if (extra[k] !== undefined) opt[k] = extra[k]; });
      var reauthed = false, busyRetried = false, netRetried = false;
      await ensureSession();
      for (;;) {
        var body = {};
        Object.keys(payload || {}).forEach(function (k) { if (k !== 'action' && k !== 'token') body[k] = payload[k]; });
        body.action = action;
        body.token = session.token;
        try {
          return await raw(body, opt);
        } catch (e) {
          if (e.code === 'AUTH_DENIED') { forget(); throw e; }
          if (e.code === 'AUTH_REQUIRED' && !reauthed) {
            reauthed = true; stats.reauth++;
            // 断られたのは「送ったときの札」。ほかの呼び出しが、もう取り直していたら（いまの札が違う）、その札を捨てずに使う
            if (session && session.token === body.token) forget();
            await ensureSession();
            continue;
          }
          if (e.code === 'BUSY' && !busyRetried && opt.retryBusy !== false) {
            busyRetried = true; stats.busyRetry++;
            await sleep(1200 + Math.floor(rnd() * 1300), opt.signal);
            continue;
          }
          if ((e.code === 'NETWORK' || e.code === 'TIMEOUT') && opt.retryNetwork && !netRetried) {
            netRetried = true; stats.netRetry++;
            await sleep(800 + Math.floor(rnd() * 700), opt.signal);
            continue;
          }
          throw e;
        }
      }
    }
    return {
      ensureSession: ensureSession, call: call, forget: forget, stats: stats,
      me: function () { return session ? session.me : null; }
    };
  }

  /** 作りかけの期限（作った時刻から12時間。手を入れても延ばさない＝個人情報を長く置かない） */
  function draftExpired(d, now) {
    if (!d || typeof d !== 'object') return true;
    var c = Number(d.createdAt);
    if (!isFinite(c) || c <= 0) return true;
    return (now || Date.now()) >= c + DRAFT_TTL_MS || c > (now || Date.now()) + 5 * 60000;
  }

  // ===== ここから下は画面（ブラウザだけ） =====
  var hasDom = (typeof document !== 'undefined');

  // ---- 端末に残す作りかけ（IndexedDB）。使えない環境では何もしない（保存できないだけ） ----
  function idbOpen() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) { reject(new Error('IndexedDB なし')); return; }
      var req;
      try { req = root.indexedDB.open(DRAFT_DB, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(DRAFT_STORE)) db.createObjectStore(DRAFT_STORE, { keyPath: 'key' });
      };
      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () { try { db.close(); } catch (e) { /* 何もしない */ } };
        resolve(db);
      };
      req.onerror = function () { reject(req.error || new Error('IndexedDB を開けません')); };
      req.onblocked = function () { reject(new Error('IndexedDB が使用中')); };
    });
  }
  async function idbRun(mode, fn) {
    var db = await idbOpen();
    try {
      return await new Promise(function (resolve, reject) {
        var tx = db.transaction(DRAFT_STORE, mode), out;
        var r = fn(tx.objectStore(DRAFT_STORE));
        if (r) r.onsuccess = function () { out = r.result; };
        tx.oncomplete = function () { resolve(out); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    } finally { try { db.close(); } catch (e) { /* 何もしない */ } }
  }
  function draftKey(email) { return 'u:' + str(email).toLowerCase(); }
  function draftGet(email) {
    return idbRun('readonly', function (st) { return st.get(draftKey(email)); }).catch(function () { return null; });
  }
  function draftPut(d) { return idbRun('readwrite', function (st) { return st.put(d); }).then(function () { return true; }, function () { return false; }); }
  function draftDelete(email) { return idbRun('readwrite', function (st) { return st.delete(draftKey(email)); }).catch(function () { return null; }); }
  /** この端末の作りかけを、だれの分もまとめて消す（使えないアカウントと分かったとき） */
  function draftForgetAll() {
    return new Promise(function (resolve) {
      try {
        if (!root.indexedDB) { resolve(); return; }
        var q = root.indexedDB.deleteDatabase(DRAFT_DB);
        q.onsuccess = q.onerror = q.onblocked = function () { resolve(); };
      } catch (e) { resolve(); }
    });
  }
  // 作りかけの期限が来たら、開いたままでも端末から消す（期限は作った時刻から12時間・延ばさない）
  var draftExpiryTimer = 0;
  function armDraftExpiry(email, createdAt) {
    if (draftExpiryTimer) { clearTimeout(draftExpiryTimer); draftExpiryTimer = 0; }
    var wait = Number(createdAt) + DRAFT_TTL_MS - Date.now();
    if (!isFinite(wait)) return;
    draftExpiryTimer = setTimeout(function () {
      draftExpiryTimer = 0;
      draftGet(email).then(function (d) { if (d && draftExpired(d)) return draftDelete(email); return null; });
      if (S.open && S.me && S.me.email === email) {
        if (S.draftOffer && draftExpired(S.draftOffer)) { S.draftOffer = null; if (S.phase === 'intro') refreshIntro(); }   // 戻す案内も下げる
        else noteDraftExpired();
      }
    }, Math.max(0, Math.min(wait, 2147483000)) + 50);
  }
  function noteDraftExpired() {
    var n = S.els && S.els.wrap && S.els.wrap.querySelector('[data-step="draft-note"]');
    if (n) n.textContent = '作りかけの保存の期限（作ってから12時間）を過ぎたので、この端末には残していません（画面を閉じると入力は消えます）。';
  }
  /**
   * 期限切れと、別の人の作りかけを消す（氏名などを端末に長く残さない。同じ端末で別のアカウントが入ったら
   * 前の人の作りかけを引き継がない＝スマレコ v81.1 の forgetPreviousAccount_ と同じ考え方）
   */
  function draftPurge(email) {
    var now = Date.now(), mine = draftKey(email);
    return idbRun('readwrite', function (st) {
      var cur = st.openCursor();
      cur.onsuccess = function () {
        var c = cur.result;
        if (!c) return;
        if (!c.value || c.value.v !== 1 || draftExpired(c.value, now) || c.key !== mine) c.delete();
        c.continue();
      };
      return null;
    }).catch(function () { return null; });
  }
  // ---- カメラの間に端末が画面を終了させたときの印（時刻と段階だけ。個人情報なし） ----
  //   localStorage と IndexedDB の両方に置く（RESUME_DB の注記）。スマレコは起動のたびにこの印を見て、
  //   おせち受注を開き直す（開けないときは、ホームで知らせる＝黙ってホームにしない）
  var resumeQueue = Promise.resolve();   // IndexedDB の書く・消すを、出した順に1つずつ
  function resumeIdb(fn) {
    resumeQueue = resumeQueue.then(function () {
      return new Promise(function (resolve) {
        try {
          if (!root.indexedDB) { resolve(null); return; }
          var q = root.indexedDB.open(RESUME_DB, 1);
          q.onupgradeneeded = function () { if (!q.result.objectStoreNames.contains(RESUME_STORE)) q.result.createObjectStore(RESUME_STORE); };
          q.onerror = q.onblocked = function () { resolve(null); };
          q.onsuccess = function () {
            var db = q.result, out = null;
            try {
              var tx = db.transaction(RESUME_STORE, 'readwrite'), r = fn(tx.objectStore(RESUME_STORE));
              if (r) r.onsuccess = function () { out = r.result; };
              tx.oncomplete = function () { db.close(); resolve(out); };
              tx.onerror = tx.onabort = function () { db.close(); resolve(null); };
            } catch (e) { try { db.close(); } catch (e2) { /* 何もしない */ } resolve(null); }
          };
        } catch (e) { resolve(null); }
      });
    });
    return resumeQueue;
  }
  /** 印を置く（stage: camera＝カメラを開く直前／photo＝写真が届いて整えて読み取っている途中） */
  function setResumeMark(stage) {
    var m = { at: Date.now(), why: 'camera', stage: stage === 'photo' ? 'photo' : 'camera' };
    S.capture = m.stage;
    try { root.localStorage.setItem(RESUME_KEY, JSON.stringify(m)); } catch (e) { /* 何もしない */ }
    resumeIdb(function (st) { return st.put(m, RESUME_REC); });
  }
  function clearResumeMark() {
    S.capture = '';
    if (S.captureTimer) { clearTimeout(S.captureTimer); S.captureTimer = 0; }
    try { root.localStorage.removeItem(RESUME_KEY); } catch (e) { /* 何もしない */ }
    // 印が無い端末に、空の保存場所を作らない（一覧で見られる端末では、有るときだけ開く）
    var dbs = root.indexedDB && typeof root.indexedDB.databases === 'function' ? root.indexedDB.databases() : null;
    if (dbs && typeof dbs.then === 'function') {
      dbs.then(function (list) {
        if ((list || []).some(function (d) { return d && d.name === RESUME_DB; })) resumeIdb(function (st) { return st.delete(RESUME_REC); });
      }, function () { resumeIdb(function (st) { return st.delete(RESUME_REC); }); });
    } else if (root.indexedDB) resumeIdb(function (st) { return st.delete(RESUME_REC); });
  }
  /** localStorage の印を読む（30分以内・形の正しいものだけ） */
  function readResumeMarkLocal() {
    try { return parseResumeMark(JSON.parse(root.localStorage.getItem(RESUME_KEY) || 'null')); } catch (e) { return null; }
  }
  /** IndexedDB の印を読む（localStorage が消えていたとき。保存場所が無ければ作らずに null） */
  function readResumeMarkIdb() {
    var dbs = root.indexedDB && typeof root.indexedDB.databases === 'function' ? root.indexedDB.databases() : null;
    var has = (dbs && typeof dbs.then === 'function')
      ? dbs.then(function (list) { return (list || []).some(function (d) { return d && d.name === RESUME_DB; }); }, function () { return true; })
      : Promise.resolve(!!root.indexedDB);
    return has.then(function (yes) {
      if (!yes) return null;
      return resumeIdb(function (st) { return st.get(RESUME_REC); }).then(function (o) { return parseResumeMark(o); });
    });
  }

  // ---- 画像: 端末で縮める（長辺 2000px・JPEG 0.82・4MB を超えたら画質と大きさを下げる） ----
  function loadImgFromBlob(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('画像を読めません')); };
      img.decoding = 'async';
      setSafeImageSrc(img, url);
    });
  }
  function canvasToBlob(canvas, quality) {
    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('画像を作れません')); }, 'image/jpeg', quality);
      else reject(new Error('この端末では画像を縮められません'));
    });
  }
  async function resizeImage(file) {
    var t0 = now();
    var src = null, w = 0, h = 0, cleanup = function () {};
    if (typeof root.createImageBitmap === 'function') {
      try {
        // 写真の向き（EXIF）を反映して読む
        var bmp = await root.createImageBitmap(file, { imageOrientation: 'from-image' });
        src = bmp; w = bmp.width; h = bmp.height;
        cleanup = function () { try { bmp.close(); } catch (e) { /* 何もしない */ } };
      } catch (e) { src = null; }
    }
    if (!src) {
      // 予備: <img> で読む（今の端末は <img> でも向きを反映する）
      var r = await loadImgFromBlob(file);
      src = r.img; w = r.img.naturalWidth; h = r.img.naturalHeight;
      cleanup = function () { URL.revokeObjectURL(r.url); };
    }
    try {
      if (!w || !h) throw new Error('画像の大きさが分かりません');
      var scale = Math.min(1, LONG_EDGE / Math.max(w, h)), quality = JPEG_QUALITY, blob = null, cw = 0, ch = 0;
      for (var attempt = 0; attempt < 8; attempt++) {
        cw = Math.max(1, Math.round(w * scale)); ch = Math.max(1, Math.round(h * scale));
        var cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        var g = cv.getContext('2d');
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, cw, ch);
        g.drawImage(src, 0, 0, cw, ch);
        blob = await canvasToBlob(cv, quality);
        cv.width = 1; cv.height = 1;
        if (blob.size <= MAX_IMAGE_BYTES) break;
        if (quality > 0.55) quality = Math.max(0.55, quality - 0.12); else scale *= 0.8;
      }
      if (!blob || blob.size > MAX_IMAGE_BYTES) throw new Error('画像を小さくできません');
      return { blob: blob, width: cw, height: ch, bytes: blob.size, quality: quality, ms: Math.round(now() - t0), srcWidth: w, srcHeight: h };
    } finally { cleanup(); }
  }
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { var s = str(fr.result); var i = s.indexOf(','); resolve(i >= 0 ? s.slice(i + 1) : ''); };
      fr.onerror = function () { reject(fr.error || new Error('読み込めません')); };
      fr.readAsDataURL(blob);
    });
  }
  function now() { return (root.performance && performance.now) ? performance.now() : Date.now(); }

  // ---- DOM を作る道具（許可した属性だけ。文字は textContent） ----
  var ALLOWED_ATTRS = {
    'class': 1, 'type': 1, 'id': 1, 'role': 1, 'tabindex': 1, 'inputmode': 1, 'autocomplete': 1, 'maxlength': 1,
    'placeholder': 1, 'aria-label': 1, 'aria-live': 1, 'aria-modal': 1, 'aria-pressed': 1, 'aria-disabled': 1,
    'aria-busy': 1, 'aria-expanded': 1, 'aria-describedby': 1, 'accept': 1, 'capture': 1, 'rows': 1, 'for': 1,
    'name': 1, 'data-field': 1, 'data-no': 1, 'data-act': 1, 'data-step': 1, 'data-kind': 1, 'enterkeyhint': 1,
    'title': 1, 'disabled': 1, 'spellcheck': 1, 'autocapitalize': 1, 'alt': 1, 'lang': 1, 'value': 1,
    'aria-current': 1, 'aria-hidden': 1, 'data-layer': 1, 'data-view': 1,
    // お客様リスト（osechi_list.js）で使う: 表の結合・見出しの範囲・スマホのカードの見出し・切り替えの印・行の注文番号
    'colspan': 1, 'rowspan': 1, 'scope': 1, 'data-label': 1, 'aria-selected': 1, 'data-tab': 1, 'data-order': 1, 'data-method': 1
  };
  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'text') { node.textContent = str(v); return; }
        if (k === 'on') { Object.keys(v).forEach(function (ev) { node.addEventListener(ev, v[ev]); }); return; }
        if (!Object.prototype.hasOwnProperty.call(ALLOWED_ATTRS, k)) throw new Error('使わない属性です: ' + k);   // constructor・__proto__ などの名前を通さない
        node.setAttribute(k, v === true ? '' : str(v));
      });
    }
    add(node, children);
    return node;
  }
  function add(node, children) {
    if (children == null) return node;
    if (!Array.isArray(children)) children = [children];
    children.forEach(function (c) {
      if (c == null || c === false) return;
      node.appendChild((typeof c === 'string' || typeof c === 'number') ? document.createTextNode(String(c)) : c);
    });
    return node;
  }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  /** 画像の src は、この画面で作った blob: のアドレスだけ */
  function setSafeImageSrc(img, url) {
    if (!/^blob:/.test(str(url))) throw new Error('使えない画像のアドレスです');
    img.src = url;
  }
  /** 読み込むスクリプトは、この osechi.js と同じ場所の osechi_list.js（版つき）だけ */
  function setSafeScriptSrc(el, url) {
    url = str(url);
    if (!/^https?:\/\/[^\/?#]+\/(?:[A-Za-z0-9._~%\-]+\/)*osechi_list\.js\?v=[A-Za-z0-9._%\-]{1,80}$/.test(url)) throw new Error('使えないスクリプトのアドレスです');
    if (root.location && url.indexOf(root.location.origin + '/') !== 0) throw new Error('ほかの場所のスクリプトは読みません');
    el.src = url;
  }
  /** ダウンロードのリンクは、この画面で作った blob: のアドレスだけ */
  function setSafeBlobHref(a, url) {
    if (!/^blob:/.test(str(url))) throw new Error('使えないリンクです');
    a.href = url;
  }
  /**
   * 保存するファイルの名前: 危ない文字・向きを変える文字を除き、長さを切ってから、拡張子を画面の側で付ける
   *   （窓口の名前を切ったあとで拡張子が変わる＝「…xxx.html」になる、を起こさない。拡張子は .xlsx・.csv だけ。ほかは .dat）
   */
  var SAVE_EXTS = { '.xlsx': 1, '.csv': 1 };
  function safeFileName(filename, ext) {
    ext = str(ext).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(SAVE_EXTS, ext)) ext = '.dat';
    var base = cleanText(filename, 300).replace(/[\\\/:*?"<>|]/g, '_');
    if (base.toLowerCase().slice(-ext.length) === ext) base = base.slice(0, -ext.length);
    base = base.slice(0, 100).replace(/[. ]+$/, '');
    return (base || 'osechi') + ext;
  }
  // 保存のために作ったリンクと Blob（閉じる・サインアウトで、すぐ消す）
  var pendingSaves = [];
  function dropSave(sv) {
    try { URL.revokeObjectURL(sv.url); } catch (e) { /* 何もしない */ }
    if (sv.a.parentNode) sv.a.parentNode.removeChild(sv.a);
    if (sv.timer) clearTimeout(sv.timer);
    pendingSaves = pendingSaves.filter(function (x) { return x !== sv; });
  }
  function dropAllSaves() { pendingSaves.slice().forEach(dropSave); }
  /** バイトの並びを、利用者の端末にファイルとして保存する（ダウンロード）。ext は '.xlsx' か '.csv' */
  function saveFile(bytes, mime, filename, ext) {
    var name = safeFileName(filename, ext);
    var blob = new Blob([bytes], { type: /^[a-z]+\/[a-z0-9.+\-]+$/i.test(str(mime)) ? mime : 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.download = name;
    setSafeBlobHref(a, url);
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    var sv = { url: url, a: a, timer: 0 };
    pendingSaves.push(sv);
    a.click();
    // iOS Safari などは保存の画面を出すまで少しかかる＝少し待ってから消す（閉じる・サインアウトでは、すぐ消す）
    sv.timer = setTimeout(function () { dropSave(sv); }, 60000);
    return name;
  }
  function lines(text) {
    var parts = str(text).split('\n'), out = [];
    parts.forEach(function (p, i) { if (i) out.push(h('br')); out.push(p); });
    return out;
  }

  // ---- 見た目（JS から1回だけ差し込む。色は「おせち」固定＝えんじと金） ----
  var CSS = [
    '#osechi-screen.hidden,#osechi-dialog.hidden,#osechi-sub.hidden,.osechi-hidden{display:none!important}',
    '.osechi-root{position:absolute;top:0;right:0;bottom:0;left:0;display:flex;flex-direction:column;background:#faf6ef;color:#1f2328;',
    'font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Meiryo",sans-serif;font-size:18px;line-height:1.6;-webkit-text-size-adjust:100%;text-align:left}',
    '.osechi-root *,.osechi-root *::before,.osechi-root *::after,#osechi-dialog,#osechi-dialog *{box-sizing:border-box}',
    '.osechi-header{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:8px 10px;padding-top:calc(8px + env(safe-area-inset-top,0px));background:#8f1d2c;color:#fff;border-bottom:4px solid #c9a227}',
    '.osechi-hbtn{flex:0 0 auto;min-height:46px;min-width:46px;padding:4px 12px;border-radius:12px;border:2px solid rgba(255,255,255,.65);background:rgba(255,255,255,.12);color:#fff;font-size:17px;font-weight:800;cursor:pointer;-webkit-tap-highlight-color:transparent}',
    '.osechi-hbtn:active{background:rgba(255,255,255,.3)}',
    '.osechi-htitle{flex:1 1 auto;min-width:0}',
    '.osechi-htitle-main{display:block;font-size:21px;font-weight:900;line-height:1.25;letter-spacing:.04em}',
    '.osechi-htitle-sub{display:block;font-size:14px;line-height:1.3;opacity:.95;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.osechi-body{flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}',
    '.osechi-wrap{max-width:720px;margin:0 auto;padding:12px 12px 28px}',
    '.osechi-footer{flex:0 0 auto;background:#fff;border-top:2px solid #e6dccd;box-shadow:0 -3px 12px rgba(0,0,0,.08);padding:10px 12px calc(16px + env(safe-area-inset-bottom,0px))}',
    '.osechi-footer-in{max-width:720px;margin:0 auto}',
    '.osechi-card{background:#fff;border:1px solid #e6dccd;border-radius:16px;padding:14px;margin:0 0 12px}',
    '.osechi-h2{font-size:20px;font-weight:900;margin:0 0 8px;color:#6e1521;line-height:1.35}',
    '.osechi-h3{position:sticky;top:0;z-index:2;font-size:19px;font-weight:900;margin:18px -12px 8px;padding:8px 12px;background:#f3e7d6;color:#5a1019;border-top:2px solid #e2cfb4;border-bottom:2px solid #e2cfb4}',
    '.osechi-note{font-size:16px;color:#4a4f57;margin:4px 0 0}',
    '.osechi-small{font-size:14px;color:#4a4f57}',
    '.osechi-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:58px;margin:0;padding:10px 16px;border-radius:14px;border:2px solid transparent;font-size:20px;font-weight:900;line-height:1.3;cursor:pointer;text-align:center;-webkit-tap-highlight-color:transparent;touch-action:manipulation;font-family:inherit}',
    '.osechi-btn:active{transform:scale(.985)}',
    '.osechi-btn[disabled],.osechi-btn[aria-disabled="true"]{opacity:.45;cursor:default;transform:none}',
    '.osechi-btn-primary{background:#8f1d2c;color:#fff;border-color:#6e1521}',
    '.osechi-btn-secondary{background:#fff;color:#6e1521;border-color:#c8ab8a}',
    '.osechi-btn-danger{background:#fff;color:#a01818;border-color:#e3a3a3}',
    '.osechi-btn-gold{background:#fff8e1;color:#5a3e00;border-color:#c9a227}',
    '.osechi-btn-link{background:transparent;border-color:transparent;color:#6e1521;text-decoration:underline;font-size:17px;min-height:46px;font-weight:800}',
    '.osechi-btn-row{display:flex;gap:8px;margin-top:8px}.osechi-btn-row>.osechi-btn{flex:1 1 0;min-width:0}',
    '.osechi-camera{min-height:118px;font-size:25px;flex-direction:column;gap:2px;position:relative;overflow:hidden}',
    '.osechi-camera-ico{font-size:42px;line-height:1}',
    '.osechi-file{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:0;top:0}',
    '.osechi-field{margin:0 0 10px}',
    '.osechi-label{display:block;font-size:16px;font-weight:800;color:#3d2a20;margin:0 0 3px}',
    '.osechi-input{display:block;width:100%;font-size:20px;line-height:1.4;padding:10px 12px;min-height:52px;border:2px solid #c9bba6;border-radius:12px;background:#fff;color:#111;font-family:inherit;-webkit-appearance:none;appearance:none}',
    'textarea.osechi-input{resize:vertical;min-height:76px}',
    'select.osechi-input{background:#fff;padding-right:12px}',
    '.osechi-input:focus,.osechi-qty:focus{outline:3px solid #e2b93b;outline-offset:1px;border-color:#8f1d2c}',
    '.osechi-input.osechi-err,.osechi-qty.osechi-err{border-color:#b42318;background:#fff4f3}',
    '.osechi-fieldmsg{font-size:15px;font-weight:800;color:#b42318;margin-top:2px}',
    '.osechi-party{border:2px solid #e6dccd;border-radius:14px;padding:10px 12px 2px;margin:0 0 10px;background:#fffdf9}',
    '.osechi-party-title{font-size:19px;font-weight:900;color:#5a1019;margin:0 0 6px}',
    '.osechi-fixed{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-radius:12px;background:#f6f1ea;border:2px solid #d8cbb8;font-size:21px;font-weight:900}',
    '.osechi-fixed small{font-size:14px;font-weight:700;color:#4a4f57}',
    '.osechi-warn{background:#fff7d6;border:2px solid #d9a400;border-radius:12px;padding:10px 12px;font-size:17px;font-weight:700;color:#5c4400;margin:8px 0}',
    '.osechi-error{background:#fff4f3;border:2px solid #d92d20;border-radius:12px;padding:10px 12px;font-size:17px;font-weight:700;color:#7a1610;margin:8px 0}',
    '.osechi-info{background:#eef5ff;border:2px solid #84adff;border-radius:12px;padding:10px 12px;font-size:16px;color:#1d3d7a;margin:8px 0}',
    '.osechi-ai{background:#fbf3e4;border:2px dashed #c9a227;border-radius:12px;padding:10px 12px;font-size:16px;color:#4a3500;margin:0 0 10px}',
    '.osechi-status-title{font-size:17px;font-weight:900;margin:0 0 6px}',
    '.osechi-status{display:block;border-radius:12px;padding:6px 12px;margin:6px 0;font-weight:900;line-height:1.35}',
    '.osechi-status-soldout{background:#fdecec;border:2px solid #c62828;color:#8e1111;font-size:28px}',
    '.osechi-status-needcall{background:#fff1e0;border:2px solid #ea7a00;color:#8a3b00;font-size:28px}',
    '.osechi-status-none{background:#f4f4f5;border:2px solid #c4c4c8;color:#4a4f57;font-size:16px;font-weight:700}',
    '.osechi-item{display:grid;grid-template-columns:54px 78px minmax(0,1fr);gap:8px;align-items:center;padding:8px;border-radius:14px;border:2px solid #e6dccd;margin:0 0 7px;background:#fff}',
    '.osechi-item-no{text-align:center;line-height:1.1}',
    '.osechi-item-num{display:block;font-size:24px;font-weight:900;color:#3d2a20}',
    '.osechi-item-name{display:block;font-size:12px;color:#4a4f57;margin-top:2px;word-break:break-all}',
    '.osechi-qty{display:block;width:100%;font-size:26px;font-weight:800;text-align:center;padding:6px 2px;min-height:54px;border:2px solid #c9bba6;border-radius:12px;background:#fff;color:#111;font-family:inherit;-webkit-appearance:none;appearance:none}',
    '.osechi-qty[disabled]{background:#e9eaec;color:#6b7280}',
    '.osechi-item-m{grid-template-columns:54px minmax(0,1fr) minmax(0,1fr)}',
    '.osechi-qcell{display:block;min-width:0;margin:0}',
    '.osechi-qlabel{display:block;font-size:15px;font-weight:900;text-align:center;line-height:1.2;margin-bottom:2px}',
    '.osechi-qcell-store .osechi-qlabel{color:#145a19}.osechi-qcell-delivery .osechi-qlabel{color:#7a3300}',
    '.osechi-qcell-store.osechi-on .osechi-qty{background:#e3f4e5;border-color:#2e7d32;color:#0f3d12}',
    '.osechi-qcell-delivery.osechi-on .osechi-qty{background:#fff0dc;border-color:#e06a00;color:#5c2600}',
    '.osechi-chips{display:flex;flex-wrap:wrap;gap:6px;min-width:0}',
    '.osechi-chip{flex:0 0 auto;min-width:64px;min-height:50px;padding:4px 10px;font-size:18px;font-weight:900;border-radius:12px;border:2px solid #c9bba6;background:#fafafa;color:#374151;cursor:pointer;font-family:inherit}',
    '.osechi-chip[disabled]{opacity:.4;cursor:default}',
    '.osechi-chip[aria-pressed="true"]{background:#efe6ff;border-color:#6941c6;color:#3b1f86}',
    '.osechi-item--warn{background:#fff7d6;border-color:#d9a400}',
    '.osechi-item--ok{background:#eef6ff;border-color:#84adff}',
    '.osechi-item--soldout{background:#eceef1}',
    '.osechi-item--needcall{border-left:9px solid #ea7a00}',
    '.osechi-item--err{background:#fff4f3;border-color:#d92d20}',
    '.osechi-item-msg{grid-column:1/-1;font-size:15px;font-weight:800;color:#6a4a00;margin:0}',
    '.osechi-item--err .osechi-item-msg{color:#9a1c12}',
    '.osechi-item-d{grid-template-columns:54px minmax(0,1fr)}',
    '.osechi-dcol{min-width:0;display:flex;flex-direction:column;gap:6px}',
    '.osechi-dhead{font-size:15px;font-weight:900;color:#3d2a20}',
    '.osechi-dqtys{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:6px}',
    '.osechi-dq{display:block;min-width:0;margin:0}',
    '.osechi-dq .osechi-qlabel{color:#3b1f86}',
    '.osechi-dq.osechi-on .osechi-qty{background:#efe6ff;border-color:#6941c6;color:#2a1663}',
    '.osechi-dsum{font-size:17px;font-weight:900;color:#2a1663}',
    '.osechi-dsum small{font-size:14px;font-weight:700;color:#4a4f57;margin-left:6px}',
    '.osechi-dtop{display:grid;grid-template-columns:96px minmax(0,1fr);gap:8px;align-items:start}',
    '.osechi-dright{min-width:0;display:flex;flex-direction:column;gap:6px}',
    '.osechi-ddates{min-width:0;display:flex;flex-direction:column;gap:6px}',
    '.osechi-dtotal .osechi-qlabel{color:#3b1f86}',
    '.osechi-dtotal.osechi-on .osechi-qty{background:#efe6ff;border-color:#6941c6;color:#2a1663}',
    '.osechi-dnone{display:flex;align-items:center;min-height:54px;margin-top:22px;padding:4px 12px;border-radius:12px;border:2px dashed #c4c4c8;background:#f4f4f5;color:#374151}',
    '.osechi-dnone b{font-size:19px;font-weight:900}',
    '.osechi-dpending{margin-top:22px;padding:6px 10px;border-radius:12px;border:2px solid #d9a400;background:#fff7d6;font-size:16px;font-weight:800;color:#5c4400}',
    '.osechi-sum{font-size:16px;font-weight:800;color:#3d2a20;margin:0 0 6px;text-align:center}',
    '.osechi-views{display:flex;gap:6px;padding:6px 10px;background:#f3e7d6;border-bottom:2px solid #e2cfb4}',
    '.osechi-views>.osechi-btn{min-height:48px;font-size:17px}',
    // スマホ（幅375）でも3つが1段に読める（2026-10-30: 上の切り替えに「受注状況一覧表」を足して3つに）
    '@media (max-width:480px){.osechi-views{gap:4px;padding:6px 6px}.osechi-views>.osechi-btn{padding:4px 2px;font-size:15px;letter-spacing:-.02em}}',
    '.osechi-views>.osechi-btn[aria-current="page"]{background:#8f1d2c;color:#fff;border-color:#6e1521}',
    '.osechi-badge{display:inline-block;font-size:13px;font-weight:900;border-radius:8px;padding:0 6px;margin-top:3px}',
    '.osechi-badge-soldout{background:#c62828;color:#fff}',
    '.osechi-badge-needcall{background:#ea7a00;color:#fff}',
    '.osechi-flash{animation:osechiFlash 1.4s ease-out 1}',
    '@keyframes osechiFlash{0%{box-shadow:0 0 0 6px rgba(226,185,59,.95)}100%{box-shadow:0 0 0 0 rgba(226,185,59,0)}}',
    '.osechi-photo{display:block;max-width:100%;max-height:55vh;margin:8px auto 0;border-radius:10px;border:1px solid #d8cbb8;background:#fff}',
    '.osechi-done-id{display:block;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:30px;font-weight:900;letter-spacing:.03em;color:#111;background:#fff8e1;border:3px solid #c9a227;border-radius:14px;padding:10px;text-align:center;margin:8px 0;word-break:break-all}',
    '.osechi-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:16px}',
    '.osechi-kv dt{font-weight:800;color:#3d2a20}.osechi-kv dd{margin:0;word-break:break-word}',
    '.osechi-table{width:100%;border-collapse:collapse;font-size:15px;margin-top:6px}',
    '.osechi-table th,.osechi-table td{border:1px solid #e6dccd;padding:4px 6px;text-align:left;word-break:break-word}',
    '.osechi-table th{background:#f3e7d6}',
    '.osechi-foot{font-size:12px;color:#6b7280;text-align:center;margin-top:18px}',
    '.osechi-guide-steps{display:flex;flex-direction:column;gap:6px;margin:6px 0 10px;padding:0;list-style:none}',
    '.osechi-guide-steps li{display:grid;grid-template-columns:52px 1fr;gap:10px;align-items:center;background:#fffdf9;border:2px solid #e6dccd;border-radius:12px;padding:8px}',
    '.osechi-guide-ico{display:flex;align-items:center;justify-content:center;width:52px;height:52px;border-radius:12px;background:#8f1d2c;color:#fff;font-size:26px}',
    '.osechi-mini{display:flex;gap:4px;margin-top:4px}.osechi-mini span{font-size:13px;font-weight:900;border-radius:7px;padding:1px 6px;border:2px solid #c9bba6;background:#fafafa}',
    '#osechi-dialog{position:fixed;top:0;right:0;bottom:0;left:0;z-index:6000;background:rgba(20,12,8,.58);display:flex;align-items:center;justify-content:center;padding:14px;',
    'font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Meiryo",sans-serif;color:#1f2328;-webkit-text-size-adjust:100%}',
    '.osechi-dlg{background:#fff;border-radius:18px;max-width:560px;width:100%;max-height:calc(100vh - 28px);overflow-y:auto;padding:18px;box-shadow:0 12px 32px rgba(0,0,0,.35);font-size:20px;line-height:1.65;text-align:left}',
    '.osechi-dlg-title{font-size:21px;font-weight:900;color:#5a1019;margin:0 0 8px}',
    '.osechi-dlg-msg{white-space:normal;word-break:break-word;margin:0 0 12px;padding:12px 14px;border-radius:12px;border-left:7px solid #c9a227;background:#fffaf0;font-weight:700}',
    '.osechi-dlg--error .osechi-dlg-msg{border-left-color:#c62828;background:#fff4f3}',
    '.osechi-dlg--needcall .osechi-dlg-msg{border-left-color:#ea7a00;background:#fff1e0;font-size:23px}',
    '.osechi-dlg .osechi-btn{margin-top:10px}',
    '.osechi-dlg-wide{max-width:900px}',
    '.osechi-photo-big{display:block;max-width:none;width:100%;height:auto}',
    '.osechi-photo-scroll{overflow:auto;max-height:70vh;border:1px solid #d8cbb8;border-radius:10px;background:#f4f4f5}',
    '#osechi-sub{position:fixed;top:0;right:0;bottom:0;left:0;z-index:5000;display:flex;flex-direction:column;background:#faf6ef;color:#1f2328;',
    'font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Meiryo",sans-serif;font-size:18px;line-height:1.6;-webkit-text-size-adjust:100%;text-align:left}',
    '#osechi-sub *{box-sizing:border-box}',
    '.osechi-sub-body{flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}',
    '.osechi-busy{text-align:center;font-size:22px;font-weight:900}',
    '.osechi-busy-sub{font-size:16px;font-weight:700;color:#4a4f57;margin-top:4px}',
    '.osechi-spin{width:56px;height:56px;margin:4px auto 12px;border-radius:50%;border:6px solid #f1dfc0;border-top-color:#8f1d2c;animation:osechiSpin .9s linear infinite}',
    '@keyframes osechiSpin{to{transform:rotate(360deg)}}',
    '@media (prefers-reduced-motion:reduce){.osechi-spin{animation-duration:3s}.osechi-flash{animation:none;outline:3px solid #e2b93b}}'
  ].join('\n');
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  // ===== 画面の状態 =====
  var S = freshState();
  function freshState() {
    return {
      open: false, seq: 0, ctx: null, els: null, api: null, me: null, cfg: null, idx: null, view: 'order',
      phase: 'intro', form: null, edited: {}, flags: null, ocrStoreName: '', dropped: [], hasOcr: false, introEls: null,
      photo: null, pending: null, draftCreatedAt: 0, draftSaveFailed: false, restored: false,
      layer: null, sub: null, subEls: null, edit: null, listMod: null, busyTimer: 0, saveTimer: 0, containerObserver: null,
      ready: false, readyPromise: null, readyError: null, timing: {}, inputs: {}, rows: {},
      draftOffer: null, lastNote: '', listeners: [],
      capture: '', captureTimer: 0,          // 開き直しの印の段階（camera／photo）
      paper: null, storeAuto: '', storeDiffOk: false   // 用紙の店名（flags.paperStore）・本部が最初から選んだ店・店と店長が「違う店名」を確かめた
    };
  }
  function isStoreRole() { return !!(S.me && (S.me.role === 'store' || S.me.role === 'lead')); }
  function alive(seq) { return S.open && S.seq === seq; }

  // ===== 重ねる画面（階層2 #osechi-sub・階層4 #osechi-dialog）の入れ物と見張り =====
  //   どちらも body 直下に1つだけ作る。スマレコの戻る操作は 'hidden' を付けるだけなので、見張りで気づいて後片付けする。
  //   こちらで閉じるときは、先に状態（S.layer／S.sub）を空にしてから 'hidden' を付ける（見張りが「スマレコが閉じた」と取り違えない）
  var layerWatch = {};
  function layerEl(name) {
    var L = LAYERS[name];
    var el = document.getElementById(L.id);
    if (!el) {
      el = h('div', { id: L.id, 'class': 'hidden', role: 'dialog', 'aria-modal': 'true', 'data-layer': String(L.level) });
      document.body.appendChild(el);
    }
    var w = layerWatch[name] || (layerWatch[name] = { el: null, obs: null });
    if (w.el !== el && typeof MutationObserver === 'function') {
      if (w.obs) w.obs.disconnect();
      w.el = el;
      w.obs = new MutationObserver(function () {
        if (!el.classList.contains('hidden')) return;
        if (name === 'dialog' && S.layer) onLayerHiddenByHost();
        if (name === 'sub' && S.sub) onSubHiddenByHost();
      });
      w.obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    }
    return el;
  }
  function dialogEl() { return layerEl('dialog'); }

  // ---- 階層2: 1枚の画面（使い方・写真・後でお客様リストの1件）。開く・閉じるはこの2つだけ ----
  function openSub(title, body, opt) {
    opt = opt || {};
    var el = layerEl('sub');
    S.sub = null;
    clear(el);
    var header = h('div', { 'class': 'osechi-header' }, [
      h('button', { type: 'button', 'class': 'osechi-hbtn', 'data-act': 'sub-close', 'aria-label': '閉じて前の画面へ戻る', text: '← 戻る', on: { click: function () { closeSub(); } } }),
      h('div', { 'class': 'osechi-htitle' }, [h('span', { 'class': 'osechi-htitle-main', text: title })])
    ]);
    var wrap = h('div', { 'class': 'osechi-wrap' }, body);
    var subBody = h('div', { 'class': 'osechi-sub-body' }, wrap);
    el.appendChild(header);
    el.appendChild(subBody);
    var footer = null;
    if (opt.footer) {
      footer = h('div', { 'class': 'osechi-footer osechi-hidden' }, h('div', { 'class': 'osechi-footer-in' }));
      el.appendChild(footer);
    }
    el.classList.remove('hidden');
    S.sub = { onClose: opt.onClose || null, title: title };
    S.subEls = { wrap: wrap, body: subBody, footer: footer, footerIn: footer ? footer.firstChild : null };
    var b = header.querySelector('button');
    if (b && b.focus) { try { b.focus({ preventScroll: true }); } catch (e) { b.focus(); } }
    return wrap;
  }
  function closeSub() {
    var s = S.sub, el = document.getElementById(SUB_ID);
    S.sub = null;
    if (el) { el.classList.add('hidden'); clear(el); }
    if (s && s.onClose) { try { s.onClose(); } catch (e) { /* 何もしない */ } }
  }
  function onSubHiddenByHost() {
    var s = S.sub, el = document.getElementById(SUB_ID);
    S.sub = null;
    if (el) clear(el);
    if (s && s.onClose) { try { s.onClose(); } catch (e) { /* 何もしない */ } }
  }

  // ---- 階層4: 確認の小窓・処理中 ----
  function showLayer(layer, card) {
    var d = dialogEl();
    S.layer = null;            // 見張りに「こちらで入れ替えた」と分かるように
    clear(d);
    d.appendChild(card);
    d.classList.remove('hidden');
    S.layer = layer;
    // 最初のフォーカスは安全な側（入力欄があれば欄・なければ「やめる」側＝data-autofocus）。Enter の押し続けで重い方へ進まない
    var first = card.querySelector('[data-autofocus]') || card.querySelector('button');
    focusEl(first);
  }
  function focusEl(el) { if (el && el.focus) { try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); } } }
  /** 小窓の中で押せるもの（フォーカスを小窓の中に閉じ込めるため） */
  function focusables(box) {
    return Array.prototype.filter.call(box.querySelectorAll('button, textarea, input, select, [tabindex]'), function (el) {
      return !el.disabled && el.getAttribute('tabindex') !== '-1' && el.offsetParent !== null || el === document.activeElement;
    });
  }
  /** Tab・Shift+Tab は小窓の中を回る。小窓の外へフォーカスが出たら戻す（受け口は読み込みのときに1回だけ足す） */
  if (hasDom) {
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Tab' || !S.layer) return;
      var d = document.getElementById(DIALOG_ID);
      if (!d || d.classList.contains('hidden')) return;
      var list = focusables(d);
      if (!list.length) { ev.preventDefault(); return; }
      var i = list.indexOf(document.activeElement);
      if (ev.shiftKey && (i <= 0)) { ev.preventDefault(); focusEl(list[list.length - 1]); }
      else if (!ev.shiftKey && (i < 0 || i === list.length - 1)) { ev.preventDefault(); focusEl(list[0]); }
    }, true);
    document.addEventListener('focusin', function (ev) {
      if (!S.layer) return;
      var d = document.getElementById(DIALOG_ID);
      if (!d || d.classList.contains('hidden') || d.contains(ev.target)) return;
      var list = focusables(d);
      if (list.length) focusEl(list[0]);
    }, true);
  }
  function hideLayer() {
    var d = document.getElementById(DIALOG_ID);
    S.layer = null;
    if (S.busyTimer) { clearInterval(S.busyTimer); S.busyTimer = 0; }
    if (d) { d.classList.add('hidden'); clear(d); }
  }
  /** スマレコが戻る操作で小窓を閉じた */
  function onLayerHiddenByHost() {
    var L = S.layer, d = document.getElementById(DIALOG_ID);
    if (!L) return;
    if (L.kind === 'busy') {
      if (L.cancelable && L.onCancel) { S.layer = null; clear(d); if (S.busyTimer) { clearInterval(S.busyTimer); S.busyTimer = 0; } L.onCancel(); return; }
      // 送信中は閉じない（結果が分からなくなるため）。戻して、ひとこと添える
      d.classList.remove('hidden');
      if (L.noteEl) L.noteEl.textContent = L.hold || '返事を待っています。終わるまでお待ちください。';
      return;
    }
    S.layer = null;
    clear(d);
    if (L.resolve) L.resolve(L.cancelValue);
  }
  /** 確認の小窓。押したボタンの id を返す（戻る操作は cancelValue） */
  function ask(opt) {
    return new Promise(function (resolve) {
      var tone = opt.tone || 'info';
      var card = h('div', { 'class': 'osechi-dlg osechi-dlg--' + tone + (opt.wide ? ' osechi-dlg-wide' : '') }, [
        opt.title ? h('div', { 'class': 'osechi-dlg-title', text: opt.title }) : null,
        opt.message != null ? h('div', { 'class': 'osechi-dlg-msg' }, lines(opt.message)) : null,
        opt.body || null
      ]);
      // 最初のフォーカス: 本文に入力欄があれば、その欄（data-autofocus を付けて渡す）。なければ「やめる」側（cancelId のボタン）
      var bodyFocus = opt.body && opt.body.querySelector ? opt.body.querySelector('[data-autofocus]') : null;
      var safeId = opt.focusId || opt.cancelId || '';
      var hasSafe = (opt.buttons || []).some(function (b) { return b.id === safeId; });
      (opt.buttons || []).forEach(function (b, i) {
        var btn = h('button', {
          type: 'button', 'class': 'osechi-btn ' + (b.kind === 'primary' ? 'osechi-btn-primary' : b.kind === 'danger' ? 'osechi-btn-danger' : b.kind === 'gold' ? 'osechi-btn-gold' : 'osechi-btn-secondary'),
          'data-act': 'dlg-' + b.id, text: b.label
        });
        if (!bodyFocus && (hasSafe ? b.id === safeId : i === 0)) btn.setAttribute('data-autofocus', '');
        btn.addEventListener('click', function () {
          if (!S.layer || S.layer.resolve !== done) return;
          hideLayer();
          resolve(b.id);
        });
        card.appendChild(btn);
      });
      function done(v) { resolve(v); }
      showLayer({ kind: 'dialog', resolve: done, cancelValue: opt.cancelId || 'cancel' }, card);
    });
  }
  function uiAlert(message, focusKey, title) {
    return ask({ tone: 'error', title: title || '確かめてください', message: message, buttons: [{ id: 'ok', label: 'OK（直す）', kind: 'primary' }], cancelId: 'ok' })
      .then(function () { if (focusKey) focusField(focusKey); });
  }
  function uiConfirm(message, labels) {
    labels = labels || {};
    return ask({ tone: labels.tone || 'info', title: labels.title || '確認', message: message,
      buttons: [{ id: 'yes', label: labels.yes || 'はい', kind: 'primary' }, { id: 'no', label: labels.no || 'いいえ', kind: 'secondary' }],
      cancelId: 'no' }).then(function (r) { return r === 'yes'; });
  }
  /** 処理中の表示（押したらすぐ出す）。cancelable なら「やめる」と戻る操作で止められる */
  function startBusy(label, opt) {
    opt = opt || {};
    var sub = h('div', { 'class': 'osechi-busy-sub', text: opt.sub || '' });
    var timeEl = h('div', { 'class': 'osechi-busy-sub', 'aria-live': 'polite' });
    var note = h('div', { 'class': 'osechi-busy-sub' });
    var card = h('div', { 'class': 'osechi-dlg osechi-busy', role: 'status', 'aria-busy': 'true' }, [
      h('div', { 'class': 'osechi-spin' }), h('div', { text: label }), sub, timeEl, note
    ]);
    var layer = { kind: 'busy', cancelable: !!opt.cancelable, onCancel: opt.onCancel || null, noteEl: note, hold: opt.hold || '' };
    if (opt.cancelable) {
      card.appendChild(h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-secondary', 'data-act': 'busy-cancel', text: opt.cancelLabel || 'やめる',
        on: { click: function () { if (S.layer === layer) { hideLayer(); if (layer.onCancel) layer.onCancel(); } } } }));
    }
    showLayer(layer, card);
    var t0 = Date.now();
    if (S.busyTimer) clearInterval(S.busyTimer);
    S.busyTimer = setInterval(function () {
      var s = Math.floor((Date.now() - t0) / 1000);
      if (s >= 3) timeEl.textContent = s + ' 秒';
    }, 1000);
    return layer;
  }
  function endBusy(layer) {
    if (S.layer && (!layer || S.layer === layer) && S.layer.kind === 'busy') hideLayer();
  }
  function isBusy() { return !!(S.layer && S.layer.kind === 'busy'); }

  // ===== 窓口を呼ぶのは、ここ1か所だけ（待ち時間・送り直しは ACTION_OPTS の表） =====
  function api(action, args, extra) {
    if (!S.api) return Promise.reject(new OsechiError('CONFIG', '', false));
    return S.api.call(action, args || {}, extra);
  }
  /**
   * 後から足す画面（お客様リストなど）へ渡す道具。画面はこれだけを使って描く（中の状態に直接触らない）。
   *   api … 窓口 ／ ask・alert・confirm … 確認の小窓 ／ busy・endBusy … 処理中 ／ openSub・closeSub … 階層2
   *   wrap・setFooter … 本文と下の操作の場所 ／ me・cfg … 区分と設定（読むだけ） ／ h … 要素を作る道具（textContent だけ）
   */
  function makeHost() {
    var seq = S.seq, view = S.view;   // 部品を開いた入口（お客様リスト／受注状況一覧表）。入口が替わったら、その部品は止まる
    return {
      build: OSECHI_UI_BUILD,
      api: api, ask: ask, alert: uiAlert, confirm: uiConfirm, busy: startBusy, endBusy: endBusy, isBusy: isBusy,
      openSub: openSub, closeSub: closeSub, h: h, clear: clear, lines: lines, setFooter: setFooter,
      wrap: S.els ? S.els.wrap : null, body: S.els ? S.els.body : null, me: S.me, cfg: S.cfg, idx: S.idx,
      alive: function () { return alive(seq) && S.view === view; },
      onlyTab: view === 'production' ? 'production' : '',   // 上の切り替えの「受注状況一覧表」から開いた＝表だけ（中の切り替えを出さない）
      editOrder: editOrder, saveFile: saveFile, stop: showAuthStop,
      util: { str: str, cleanText: cleanText, toInt: toInt, nfkc: nfkc, isDefinitive: isDefinitive, makeSubmissionId: makeSubmissionId }
    };
  }
  /** ログインの確認ができない・使えないアカウント（本部の許可リストから外れた など）→ 案内して閉じる（静かな再交換はしない） */
  function showAuthStop(e) {
    if (S.edit) leaveEdit(false);
    disposeListModule();
    hideLayer();
    if (e && e.code === 'AUTH_DENIED') {
      // このアカウントでは使えない＝端末に残した作りかけ（氏名・住所・電話）も残さない（閉じるときにも書き戻さない）
      S.form = null; S.pending = null; S.discarded = true;
      if (S.saveTimer) { clearTimeout(S.saveTimer); S.saveTimer = 0; }
      clearResumeMark();
      draftForgetAll();
    }
    renderMessage({ tone: 'error', title: e && e.code === 'AUTH_DENIED' ? 'このアカウントでは使えません' : 'ログインの確認ができません', text: (e && e.message) || DEFAULT_MESSAGES.AUTH_REQUIRED });
  }
  function isAuthStop(e) { return !!(e && (e.code === 'AUTH_DENIED' || e.code === 'SUMARECO_LOGIN' || e.code === 'AUTH_REQUIRED')); }
  // ===== 開く・閉じる =====
  function open(ctx) {
    if (!hasDom) throw new Error('ブラウザの中で使ってください');
    if (S.open) return;
    if (!ctx || !ctx.container || typeof ctx.getSumarecoToken !== 'function') throw new Error('おせち受注を開く準備が足りません');
    injectStyle();
    S = freshState();
    S.open = true;
    S.seq = Date.now();
    S.ctx = ctx;
    // カメラの間・写真を整えて読み取っている間に、端末が画面を終了させて、スマレコが開き直した（principles_mobile_web_state_survival）。
    //   印は localStorage → 無ければ IndexedDB（ブラウザごと終了すると localStorage の書き込みが消えうる）。読んだら両方消す
    var mark = parseResumeMark(ctx.resumeMark) || readResumeMarkLocal(), seq0 = S.seq;
    if (mark) { S.lastNote = resumeNoteFor(mark); clearResumeMark(); }
    else {
      readResumeMarkIdb().then(function (m2) {
        if (!alive(seq0) || S.capture) return;   // 読む間に次の撮影を始めていたら、その印を消さない
        if (m2) { S.lastNote = resumeNoteFor(m2); if (S.phase === 'intro') refreshIntro(); }
        clearResumeMark();   // 古い印・形の違う印も残さない
      });
    }
    buildFrame();
    watchContainer();
    listen(document, 'visibilitychange', function () {
      if (document.visibilityState === 'hidden') { saveDraftNow(); return; }
      // 同じ画面のまま戻ってきた＝終了させられていない。写真が届けば onPhotoChosen が段階を進める。
      //   届かないまま（撮らずに戻った・届かない端末）なら、少し待って印を消す（すぐ消すと、このあと写真を整える間に
      //   終了させられたとき、開き直せない）
      if (S.capture === 'camera') {
        if (S.captureTimer) clearTimeout(S.captureTimer);
        S.captureTimer = setTimeout(function () { S.captureTimer = 0; if (S.capture === 'camera') clearResumeMark(); }, 4000);
      }
    });
    listen(root, 'pagehide', function () { saveDraftNow(); });
    if (!isAllowedApiUrl(ctx.apiUrl)) {
      renderMessage({ tone: 'error', title: '準備中です', text: DEFAULT_MESSAGES.CONFIG });
      return;
    }
    var profile = ctx.profile || {};
    S.api = createApi({
      apiUrl: ctx.apiUrl, fetch: root.fetch.bind(root), getSumarecoToken: ctx.getSumarecoToken,
      storage: safeSessionStorage(), sleep: sleep, expectEmail: profile.email, expectShop: profile.shop
    });
    showView(S.view);
    S.readyPromise = prepare(S.seq);
    S.readyPromise.catch(function () { /* 画面で知らせる */ });
  }
  function close(opts) {
    opts = opts || {};
    if (!S.open) return;
    var ctx = S.ctx;
    teardown(!!opts.discard);
    if (!opts.byHost) {
      if (ctx && typeof ctx.onClose === 'function') { try { ctx.onClose(); } catch (e) { /* 何もしない */ } }
      else if (ctx && ctx.container) ctx.container.classList.add('hidden');
    }
  }
  /** 後片付け。discard＝サインアウト（作りかけを保存し直さない＝消したあとに書き戻さない） */
  function teardown(discard) {
    if (S.phase === 'review' && !discard) saveDraftNow();
    if (discard) { S.form = null; S.pending = null; S.discarded = true; }
    if (S.layer && S.layer.kind === 'busy' && S.layer.cancelable && S.layer.onCancel) { try { S.layer.onCancel(); } catch (e) { /* 何もしない */ } }
    hideLayer();
    if (S.sub) { S.sub.onClose = null; closeSub(); }
    S.edit = null;
    disposeListModule();
    clearResumeMark();
    if (S.saveTimer) { clearTimeout(S.saveTimer); S.saveTimer = 0; }
    if (S.containerObserver) { S.containerObserver.disconnect(); S.containerObserver = null; }
    S.listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2]); });
    S.listeners = [];
    revokePhoto();
    dropAllSaves();   // ダウンロードの隠しリンクと Blob（お客様の情報）を残さない
    if (S.ctx && S.ctx.container) clear(S.ctx.container);   // 氏名などを画面に残さない
    S.open = false;
    S.seq = 0;
    S.form = null;
  }
  function listen(target, ev, fn) { target.addEventListener(ev, fn); S.listeners.push([target, ev, fn]); }
  function watchContainer() {
    var c = S.ctx.container;
    if (typeof MutationObserver !== 'function') return;
    S.containerObserver = new MutationObserver(function () {
      if (c.classList.contains('hidden') && S.open) close({ byHost: true });
    });
    S.containerObserver.observe(c, { attributes: true, attributeFilter: ['class'] });
  }
  function safeSessionStorage() { try { return root.sessionStorage; } catch (e) { return null; } }
  function sleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(resolve, ms);
      if (signal) signal.addEventListener('abort', function () { clearTimeout(t); reject(new OsechiError('ABORTED', 'やめました', false)); });
    });
  }
  function requestClose() { close({}); }

  /** 札 → 設定 → 作りかけの順に用意する。撮影はこれを待たずに始められる */
  async function prepare(seq) {
    try {
      await S.api.ensureSession();
      if (!alive(seq)) return false;
      S.me = S.api.me();
      updateHeader();
      var purged = draftPurge(S.me.email);   // 設定の読み込みと並べて行う（待ち時間を足さない）
      var cfg = await api('getConfig');
      await purged;
      if (!alive(seq)) return false;
      S.cfg = sanitizeConfig(cfg);
      S.idx = buildIndex(S.cfg);
      S.ready = true;
      S.readyError = null;
      var d = await draftGet(S.me.email);
      if (!alive(seq)) return false;
      if (d && draftExpired(d)) { draftDelete(S.me.email); d = null; }
      S.draftOffer = (d && d.v === 1) ? d : null;
      if (S.draftOffer) armDraftExpiry(S.me.email, S.draftOffer.createdAt);   // 開いたままでも、期限が来たら消す
      refreshIntro();
      return true;
    } catch (e) {
      if (!alive(seq)) return false;
      S.readyError = e;
      if (isAuthStop(e)) {
        showAuthStop(e);
      } else {
        refreshIntro();
      }
      throw e;
    }
  }
  function retryPrepare() {
    S.readyError = null;
    S.readyPromise = prepare(S.seq);
    S.readyPromise.catch(function () { /* 画面で知らせる */ });
    refreshIntro();
  }

  // ===== モードの中の切り替え（後でお客様リストを足す） =====
  //   1行足すと、上部の切り替えに出る（2つ以上あるときだけ出す）。render(host) は本文 host.wrap と下の操作 host.setFooter に描く。
  //   区分で出し分けるときは roles に区分を並べる（使えるかどうかは、いつも窓口が決める）。
  var VIEWS = [
    { id: 'order', label: '注文を入れる', roles: ['store', 'lead', 'hq'],
      render: function () { if (S.form && S.ready) renderReview(); else renderIntro(); },
      leave: function () { if (S.phase === 'review') saveDraftNow(); } },
    { id: 'customers', label: 'お客様リスト', roles: ['store', 'lead', 'hq'], render: renderCustomersView, leave: disposeListModule },
    // 受注状況一覧表（PO 2026-10-30「上の切り替えに足す」）: お客様リストの部品を、表だけの形で開く
    { id: 'production', label: '受注状況一覧表', roles: ['store', 'lead', 'hq'], render: renderCustomersView, leave: disposeListModule }
  ];
  /** 区分で使える切り替え。区分が分かるまでは最初の1つだけ（切り替えは出さない） */
  function viewsFor(role) { return role ? VIEWS.filter(function (v) { return v.roles.indexOf(role) >= 0; }) : VIEWS.slice(0, 1); }
  function showView(id) {
    if (isBusy() || S.edit) return;
    var v = VIEWS.filter(function (x) { return x.id === id; })[0] || VIEWS[0];
    var cur = VIEWS.filter(function (x) { return x.id === S.view; })[0];
    if (cur && cur.id !== v.id && cur.leave) cur.leave();
    S.view = v.id;
    refreshViewTabs();
    v.render(makeHost());
  }

  // ===== お客様リスト（SPEC §15・§17）: 部品 osechi_list.js は、開いたときに初めて読む（注文を入れる画面を重くしない） =====
  var listModPromise = null;
  /** お客様リストの部品の具合: ''＝使える／'missing'＝まだ無い／'skew'＝版が違う（配信の切り替わりの途中など。電波では直らない＝画面の読み直しが要る） */
  function listModuleProblem(mod, build) {
    if (!mod) return 'missing';
    return mod.build === build ? '' : 'skew';
  }
  function skewError() {
    var e = new Error('おせち受注の画面が新しくなっています（入れ替えの途中です）。お客様リストを開くには、画面を読み込み直してください。');
    e.code = 'VERSION_SKEW';
    return e;
  }
  function loadListModule() {
    var pr = listModuleProblem(root.OsechiListModule, OSECHI_UI_BUILD);
    if (!pr) return Promise.resolve(root.OsechiListModule);
    if (pr === 'skew') return Promise.reject(skewError());   // 一度入った部品は差し替えられない（読み直しのほかに直す方法が無い）
    if (listModPromise) return listModPromise;
    var url = listModuleUrl(SELF_SRC, OSECHI_UI_BUILD);
    if (!url) return Promise.reject(new Error('お客様リストの部品の場所が分かりません'));
    listModPromise = new Promise(function (resolve, reject) {
      var sc = document.createElement('script');
      sc.async = true;
      sc.onload = function () {
        var p2 = listModuleProblem(root.OsechiListModule, OSECHI_UI_BUILD);
        if (!p2) resolve(root.OsechiListModule);
        else { listModPromise = null; reject(p2 === 'skew' ? skewError() : new Error('お客様リストの部品を読み込めません')); }
      };
      sc.onerror = function () { listModPromise = null; if (sc.parentNode) sc.parentNode.removeChild(sc); reject(new Error('お客様リストの部品を読み込めません')); };
      setSafeScriptSrc(sc, url);
      (document.head || document.documentElement).appendChild(sc);
    });
    return listModPromise;
  }
  function renderCustomersView() {
    if (!S.open) return;
    S.phase = 'list';
    var w = S.els.wrap, seq = S.seq, view = S.view;
    clear(w);
    setFooter(null);
    updateHeader();
    var box = h('div', { 'class': 'osechi-card', 'data-step': 'list-loading', role: 'status', text: view === 'production' ? '受注状況一覧表を開いています…' : 'お客様リストを開いています…' });
    w.appendChild(box);
    Promise.resolve(S.readyPromise).then(loadListModule).then(function (mod) {
      if (!alive(seq) || S.view !== view) return;
      S.listMod = mod;
      mod.render(makeHost());
    }, function (e) {
      if (!alive(seq) || S.view !== view) return;
      if (isAuthStop(S.readyError)) return;   // 準備の段階で案内を出してある
      clear(w);
      if (e && e.code === 'VERSION_SKEW') {
        // 版の食い違いは、電波では直らない（入った部品は差し替えられない）＝画面を読み込み直す。作りかけは端末に残っている
        var inReview = S.phase === 'review';
        if (inReview) saveDraftNow();
        w.appendChild(h('div', { 'class': 'osechi-error', role: 'alert', 'data-step': 'list-skew' }, [
          h('div', { text: e.message }),
          inReview ? h('div', { 'class': 'osechi-small', text: '入力の途中の注文は、この端末に残っています（読み込み直したあと、おせち受注を開くと戻せます）。' }) : null,
          h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-primary', 'data-act': 'list-reload', text: '画面を読み込み直す',
            on: { click: function () { try { root.location.reload(); } catch (e2) { /* 何もしない */ } } } })
        ]));
        return;
      }
      w.appendChild(h('div', { 'class': 'osechi-error', role: 'alert' }, [
        h('div', { text: (S.readyError && S.readyError.message) || 'お客様リストを開けませんでした。電波の良い所で、もう一度お試しください。' }),
        h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-secondary', 'data-act': 'list-retry', text: 'もう一度開く',
          on: { click: function () { if (S.readyError) retryPrepare(); renderCustomersView(); } } })   // いまの入口（お客様リスト／受注状況一覧表）のまま開き直す
      ]));
    });
  }
  function disposeListModule() {
    var m = S.listMod;
    S.listMod = null;
    if (m && typeof m.dispose === 'function') { try { m.dispose(); } catch (e) { /* 何もしない */ } }
  }
  function refreshViewTabs() {
    if (!S.els) return;
    var nav = S.els.views, list = viewsFor(S.me && S.me.role);
    clear(nav);
    nav.classList.toggle('osechi-hidden', list.length < 2);
    if (list.length < 2) return;
    list.forEach(function (v) {
      nav.appendChild(h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-secondary', 'data-act': 'view', 'data-view': v.id,
        'aria-current': S.view === v.id ? 'page' : null, text: v.label, on: { click: function () { showView(v.id); } } }));
    });
  }

  // ===== 枠（ヘッダ・切り替え・本文・下の操作） =====
  function buildFrame() {
    var c = S.ctx.container;
    clear(c);
    var sub = h('span', { 'class': 'osechi-htitle-sub', text: '確認しています…' });
    var header = h('div', { 'class': 'osechi-header' }, [
      h('button', { type: 'button', 'class': 'osechi-hbtn', 'data-act': 'close', 'aria-label': 'おせち受注を閉じてホームへ戻る', text: '← 戻る', on: { click: requestClose } }),
      h('div', { 'class': 'osechi-htitle' }, [h('span', { 'class': 'osechi-htitle-main', text: 'おせち受注' }), sub]),
      h('button', { type: 'button', 'class': 'osechi-hbtn', 'data-act': 'guide', text: '使い方', on: { click: showGuide } })
    ]);
    var views = h('div', { 'class': 'osechi-views osechi-hidden', 'data-step': 'views', role: 'group', 'aria-label': 'おせち受注の中の切り替え' });
    var wrap = h('div', { 'class': 'osechi-wrap' });
    var body = h('div', { 'class': 'osechi-body' }, wrap);
    var footer = h('div', { 'class': 'osechi-footer osechi-hidden' }, h('div', { 'class': 'osechi-footer-in' }));
    var rootEl = h('div', { 'class': 'osechi-root', lang: 'ja' }, [header, views, body, footer]);
    c.appendChild(rootEl);
    S.els = { root: rootEl, sub: sub, views: views, body: body, wrap: wrap, footer: footer, footerIn: footer.firstChild };
  }
  function updateHeader() {
    if (!S.els) return;
    var t;
    if (!S.me) t = '確認しています…';
    else if (isStoreRole()) t = '店: ' + S.me.store + (S.me.role === 'lead' ? '（店長）' : '');
    else t = '本部（店を選んで登録します）';
    S.els.sub.textContent = t;
    refreshViewTabs();
  }
  function setFooter(children) {
    clear(S.els.footerIn);
    if (!children) { S.els.footer.classList.add('osechi-hidden'); return; }
    add(S.els.footerIn, children);
    S.els.footer.classList.remove('osechi-hidden');
  }
  function scrollTop() { if (S.els) S.els.body.scrollTop = 0; }
  // ===== ① はじめに（受付期間・売り切れ／要電話確認・撮影） =====
  //   撮影の入口は1回だけ作る。準備が終わったときは周りの欄だけを書き換える
  //   （カメラを開いている間に入口を作り直すと、撮った写真を受け取れなくなるため）
  /** カメラ・アルバムを開く。開く直前に「開いていた」印を残す（端末が画面を終了させても、開き直せるように） */
  function openPicker(input) {
    if (isBusy() || !S.open) return;
    if (S.phase === 'review') saveDraftNow();
    setResumeMark('camera');
    input.click();
  }
  /** カメラ・アルバムの入口（input）。写真が届いたら読み取りへ・やめたら印を消す（cancel は Chrome 113・Safari 16.4 から） */
  function pickerInput(attrs) {
    var inp = h('input', attrs);
    inp.addEventListener('change', function () { onPhotoChosen(inp); });
    inp.addEventListener('cancel', function () { if (S.capture === 'camera') clearResumeMark(); });
    return inp;
  }
  function renderIntro() {
    if (!S.open) return;
    S.phase = 'intro';
    S.inputs = {}; S.rows = {};
    var w = S.els.wrap;
    clear(w);
    setFooter(null);
    var I = S.introEls = { err: h('div'), note: h('div'), last: h('div'), draft: h('div'), status: h('div'), admin: h('div'), foot: h('div') };

    var camInput = pickerInput({ type: 'file', accept: 'image/*', capture: 'environment', 'class': 'osechi-file', 'data-act': 'camera-input', 'aria-label': 'カメラで撮影', tabindex: '-1' });
    var albInput = pickerInput({ type: 'file', accept: 'image/*', 'class': 'osechi-file', 'data-act': 'album-input', 'aria-label': 'アルバムから選ぶ', tabindex: '-1' });
    var camBtn = h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-primary osechi-camera', 'data-act': 'camera' }, [
      h('span', { 'class': 'osechi-camera-ico', text: '📷' }), h('span', { text: '注文書を撮影して読み取る' })
    ]);
    camBtn.addEventListener('click', function () { openPicker(camInput); });
    var albBtn = h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-secondary', 'data-act': 'album', text: '🖼 アルバムの写真から読み取る' });
    albBtn.addEventListener('click', function () { openPicker(albInput); });
    var manBtn = h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-link', 'data-act': 'manual', text: '写真なしで、手で入力する', on: { click: startManual } });
    I.capButtons = [camBtn, albBtn, manBtn];
    var cap = h('div', { 'class': 'osechi-card', 'data-step': 'capture' }, [
      camBtn, camInput, albInput,
      h('div', { 'class': 'osechi-btn-row' }, [albBtn]),
      h('p', { 'class': 'osechi-note', text: '明るい所で、注文書の全体が入るように真上から撮ってください。写真はこの端末にも窓口にも残しません。' }),
      manBtn
    ]);
    add(w, [I.err, I.note, I.last, I.draft, cap, I.status, I.admin, I.foot]);
    refreshIntro();
    scrollTop();
  }
  function refreshIntro() {
    if (!S.open || S.phase !== 'intro' || !S.introEls) return;
    var I = S.introEls;
    updateHeader();
    clear(I.err);
    if (S.readyError && S.readyError.code !== 'AUTH_DENIED') {
      I.err.appendChild(h('div', { 'class': 'osechi-error', role: 'alert' }, [
        h('div', { text: S.readyError.message }),
        h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-secondary', 'data-act': 'retry-prepare', text: 'もう一度読み込む', on: { click: retryPrepare } })
      ]));
    }
    clear(I.note);
    // ひとことは、はじめの画面にいるあいだ出し続ける（準備が終わって描き直しても消さない）。画面を移るときに消す
    if (S.lastNote) I.note.appendChild(h('div', { 'class': 'osechi-info', role: 'status', 'data-step': 'note', text: S.lastNote }));
    clear(I.last);
    var last = readLastDone();
    if (last) {
      I.last.appendChild(h('div', { 'class': 'osechi-info', 'data-step': 'last-done' }, [
        h('b', { text: '前回の送信は受け付けられています' }), h('br'),
        '受付番号 ' + last.orderId + (last.store ? '（' + last.store + '）' : '')
      ]));
    }
    clear(I.draft);
    if (S.draftOffer) I.draft.appendChild(draftOfferCard(S.draftOffer));
    var denied = !!(S.readyError && S.readyError.code === 'AUTH_DENIED');
    I.capButtons.forEach(function (b) { b.disabled = denied; });

    clear(I.status);
    var st = h('div', { 'class': 'osechi-card', 'data-step': 'status' });
    st.appendChild(h('div', { 'class': 'osechi-status-title', text: '商品の状態（本部の設定）' }));
    if (!S.ready) {
      st.appendChild(h('div', { 'class': 'osechi-status osechi-status-none', text: S.readyError ? '読み込めませんでした' : '読み込んでいます…' }));
    } else {
      if (!S.idx.methodNos.length && !S.idx.dateNos.length) {
        st.appendChild(h('div', { 'class': 'osechi-error', text: '商品の設定がありません。本部へお知らせください（このままでは送れません）。' }));
      }
      if (S.idx.soldout.length) st.appendChild(h('div', { 'class': 'osechi-status osechi-status-soldout', 'data-kind': 'soldout', text: '売り切れ：' + S.idx.soldout.join(', ') }));
      if (S.idx.needcall.length) st.appendChild(h('div', { 'class': 'osechi-status osechi-status-needcall', 'data-kind': 'needcall', text: '要電話確認：' + S.idx.needcall.join(', ') }));
      if (!S.idx.soldout.length && !S.idx.needcall.length) st.appendChild(h('div', { 'class': 'osechi-status osechi-status-none', text: 'いま、売り切れ・要電話確認の商品はありません。' }));
      var season = seasonText(S.cfg.season);
      if (season) st.appendChild(h('p', { 'class': 'osechi-note', text: season }));
      // 受付期間の外（窓口が open:false を返した）。入力はできるが、送ると断られる＝先に知らせる
      if (S.cfg.season.isOpen === false) st.appendChild(h('div', { 'class': 'osechi-error', 'data-kind': 'closed', text: 'いまは受付期間の外です。注文を送ることはできません。' }));
    }
    I.status.appendChild(st);
    clear(I.admin);
    if (S.me && S.me.isAdmin) I.admin.appendChild(adminCard());
    clear(I.foot);
    I.foot.appendChild(footNote());
  }
  function seasonText(season) {
    if (!season || (!season.start && !season.end)) return '';
    return '受付期間: ' + fmtDateTime(season.start) + ' 〜 ' + fmtDateTime(season.end);
  }
  function fmtDateTime(s) {
    s = str(s);
    if (!s) return '';
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    if (!m) return s;
    var t = Number(m[2]) + '/' + Number(m[3]);
    if (m[4] && !(m[4] === '00' && m[5] === '00')) t += (m[4] === '12' && m[5] === '00') ? ' 正午' : ' ' + Number(m[4]) + ':' + m[5];
    return t;
  }
  function footNote() {
    return h('div', { 'class': 'osechi-foot', text: '画面 ' + OSECHI_UI_BUILD + (S.cfg && S.cfg.build ? ' ／ 窓口 ' + S.cfg.build : '') });
  }
  function readLastDone() {
    try {
      var raw = root.sessionStorage.getItem(LAST_DONE_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !/^[0-9A-Za-z-]{1,40}$/.test(str(o.orderId))) return null;
      if (Date.now() - Number(o.at) > 6 * 3600000) return null;
      if (S.me && o.email && o.email !== S.me.email) return null;
      return { orderId: str(o.orderId), store: cleanText(o.store, LIMITS.store) };
    } catch (e) { return null; }
  }
  function writeLastDone(r) {
    try { root.sessionStorage.setItem(LAST_DONE_KEY, JSON.stringify({ orderId: r.orderId, store: r.store, at: Date.now(), email: S.me ? S.me.email : '' })); } catch (e) { /* 何もしない */ }
  }
  function draftOfferCard(d) {
    var created = new Date(Number(d.createdAt));
    var leftH = Math.max(0, Math.ceil((Number(d.createdAt) + DRAFT_TTL_MS - Date.now()) / 3600000));
    var hm = created.getHours() + ':' + ('0' + created.getMinutes()).slice(-2);
    return h('div', { 'class': 'osechi-card', 'data-step': 'draft-offer' }, [
      h('div', { 'class': 'osechi-h2', text: '作りかけの注文があります' }),
      h('p', { 'class': 'osechi-note', text: hm + ' に始めた注文です（あと約 ' + leftH + ' 時間で、この端末から自動で消えます）。' }),
      d.pending ? h('div', { 'class': 'osechi-warn', text: '前回の送信の結果が分かっていません。続きから「送信」を押すと、同じ注文として送り直します（二重にはなりません）。' }) : null,
      h('div', { 'class': 'osechi-btn-row' }, [
        h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-gold', 'data-act': 'draft-restore', text: '続きから入力する', on: { click: function () { restoreDraft(d); } } }),
        h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-secondary', 'data-act': 'draft-discard', text: '捨てる', on: { click: discardDraftOffer } })
      ])
    ]);
  }
  async function discardDraftOffer() {
    var d = S.draftOffer;
    if (d && d.pending) {
      if (!await uiConfirm('前回の送信の結果が分かっていない注文です。\n捨てると、受け付けられていたかどうかを、この画面では確かめられなくなります。\n捨ててよろしいですか？', { yes: '捨てる', no: 'やめる', tone: 'error' })) return;
    }
    S.draftOffer = null;
    if (S.me) await draftDelete(S.me.email);
    refreshIntro();
  }

  // ===== ② 撮影 → 縮小 → 読み取り =====
  async function onPhotoChosen(input) {
    var file = input.files && input.files[0];
    input.value = '';
    if (!S.open) return;
    if (isBusy()) return;   // 処理中に2つ目が届いた（二度押し）: いまの処理を続ける
    if (!file) {
      // 写真が届かなかった（端末によっては、撮影を終えても写真が渡らないことがある）。黙って戻らず、次にすることを出す
      clearResumeMark();
      await uiAlert('写真を受け取れませんでした。\nもう一度「注文書を撮影して読み取る」を押してください。続けて起きるときは、端末のカメラで撮ってから「アルバムの写真から読み取る」を使ってください。', '', '写真が届きませんでした');
      return;
    }
    // 写真が届いた。整えて読み取っている間に端末が画面を終了させても、開き直して知らせる（印を「写真の途中」に進める）
    setResumeMark('photo');
    var seq = S.seq;
    if (file.type && !/^image\//.test(file.type)) { clearResumeMark(); await uiAlert('写真（画像）を選んでください。'); return; }
    var layer = startBusy('写真を整えています…', { hold: '写真を整えています。終わるまでお待ちください（数秒です）。' });
    var r;
    try { r = await resizeImage(file); }
    catch (e) {
      endBusy(layer);
      clearResumeMark();
      if (alive(seq)) await uiAlert('この写真は読み込めませんでした。\nカメラで撮り直すか、別の写真を選んでください（HEIC などの形式は読めないことがあります）。', '', '写真を読めません');
      return;
    }
    if (!alive(seq)) return;
    endBusy(layer);
    revokePhoto();
    S.photo = r;
    S.photo.url = URL.createObjectURL(r.blob);
    S.timing.resizeMs = r.ms;
    S.timing.imageKb = Math.round(r.bytes / 1024);
    await runOcr(seq);
  }
  function revokePhoto() {
    if (S.photo && S.photo.url) { try { URL.revokeObjectURL(S.photo.url); } catch (e) { /* 何もしない */ } }
    S.photo = null;
  }
  async function runOcr(seq) {
    if (!S.photo || !alive(seq)) return;
    var ac = (typeof AbortController === 'function') ? new AbortController() : null;
    var cancelled = false;
    var layer = startBusy('読み取っています…', {
      sub: 'AI が注文書を読んでいます（ふつう 10〜30 秒）', cancelable: true,
      onCancel: function () { cancelled = true; if (ac) ac.abort(); }
    });
    function stopped() { clearResumeMark(); if (alive(seq)) { S.lastNote = '読み取りをやめました。'; refreshIntro(); } }
    try {
      await S.readyPromise;
      if (!alive(seq)) return;
      if (cancelled) return stopped();
      var b64 = await blobToBase64(S.photo.blob);
      if (!alive(seq)) return;
      if (cancelled) return stopped();
      var t0 = now();
      var res = await api('ocr', { image: { base64: b64, mime: 'image/jpeg' }, storeHint: isStoreRole() ? S.me.store : '' },
        { signal: ac ? ac.signal : null });
      b64 = null;
      if (!alive(seq)) return;
      if (cancelled) return stopped();
      S.timing.ocrMs = Math.round(now() - t0);
      endBusy(layer);
      startReviewFromOcr(res);
    } catch (e) {
      endBusy(layer);
      if (!alive(seq)) return;
      if (cancelled || e.code === 'ABORTED') return stopped();
      clearResumeMark();   // 理由を画面に出す＝開き直しの印は要らない
      if (isAuthStop(e)) { showAuthStop(e); return; }
      var choice = await ask({
        tone: 'error', title: '読み取れませんでした', message: e.message,
        buttons: [
          e.code === 'BAD_REQUEST' || e.code === 'RATE_LIMITED' || e.code === 'CLOSED' ? null : { id: 'retry', label: 'もう一度読み取る', kind: 'primary' },
          { id: 'manual', label: '写真なしで、手で入力する', kind: 'secondary' },
          { id: 'cancel', label: 'やめる', kind: 'secondary' }
        ].filter(Boolean), cancelId: 'cancel'
      });
      if (!alive(seq)) return;
      if (choice === 'retry') return runOcr(seq);
      if (choice === 'manual') return startManual();
    }
  }
  function startReviewFromOcr(res) {
    clearResumeMark();   // 確かめの画面まで来た＝開き直しの印は要らない
    var r = formFromParsed(res && res.parsed, S.idx);
    var fl = (res && res.flags && typeof res.flags === 'object') ? res.flags : {};
    var fq = formQtyByItem(fl.warnings);
    Object.keys(fq).forEach(function (no) { if (r.form.dateItems[no] && !r.form.dateItems[no].hint) r.form.dateItems[no].hint = String(fq[no]); });
    S.form = r.form;
    S.ocrStoreName = r.storeName;
    S.dropped = r.dropped;
    S.flags = {
      storeMatched: fl.storeMatched === true ? true : (fl.storeMatched === false ? false : null),
      storeMessage: cleanText(fl.storeMessage, 200),
      paper: sanitizePaperStore(fl.paperStore),
      suspicious: fl.suspiciousDated === true || fl.suspicious21_32 === true,
      missing: cleanMissing(fl.missing),
      warnings: cleanWarnings(fl.warnings)
    };
    applyStoreForRole();
    S.edited = {};
    S.pending = null;
    S.restored = false;
    S.draftCreatedAt = Date.now();
    S.hasOcr = true;
    S.draftOffer = null;
    renderReview();
    saveDraftNow();
  }
  /**
   * 店の欄を区分ごとに決める: 店・店長＝自店（変えられない）／本部＝注文書の店名が店の一覧の1店に決まれば（paperStore.how＝exact）
   *   その店を最初から選んでおく（PO 2026-10-29「受付店舗名を拾えば登録できるように」。変えられる）。決まらなければ空（選んでもらう）。
   *   「違う店舗の予約」を確かめた印は、新しい注文書のたびに下ろす
   */
  function applyStoreForRole() {
    S.storeDiffOk = false;
    S.storeAuto = '';
    if (isStoreRole()) { S.form.store = S.me.store; return; }
    var auto = paperStoreAuto(S.flags && S.flags.paper, storeList());
    S.form.store = auto;
    S.storeAuto = auto;
  }
  function storeList() { return (S.cfg && S.cfg.stores && S.cfg.stores.length) ? S.cfg.stores : ((S.me && S.me.stores) || []); }
  async function startManual() {
    if (isBusy()) return;
    try { await S.readyPromise; } catch (e) { return; }
    if (!S.open || !S.ready) return;
    revokePhoto();
    S.form = emptyForm(S.idx);
    S.form.receptionist = RECEPTIONIST_NONE;   // 空のまま送らない（直せる）
    S.ocrStoreName = ''; S.dropped = []; S.flags = null; S.edited = {}; S.pending = null; S.restored = false; S.hasOcr = false;
    applyStoreForRole();
    S.draftCreatedAt = Date.now();
    S.draftOffer = null;
    renderReview();
  }
  function restoreDraft(d) {
    if (!S.ready || isBusy()) return;
    if (draftExpired(d)) {   // 案内を出したあとで期限が来た: 戻さずに消す
      S.draftOffer = null;
      if (S.me) draftDelete(S.me.email);
      refreshIntro();
      return;
    }
    S.form = formFromDraft(d.form, S.idx);
    S.ocrStoreName = cleanText(d.ocrStoreName, LIMITS.store);
    S.dropped = [];
    S.flags = d.flags ? {
      storeMatched: d.flags.storeMatched === true ? true : (d.flags.storeMatched === false ? false : null),
      storeMessage: cleanText(d.flags.storeMessage, 200), paper: sanitizePaperStore(d.flags.paper), suspicious: d.flags.suspicious === true,
      missing: cleanMissing(d.flags.missing), warnings: cleanWarnings(d.flags.warnings)
    } : null;
    applyStoreForRole();   // 本部は前に選んだ店を引き継がない（この注文書の店名から選び直す）
    S.edited = {};
    (Array.isArray(d.edited) ? d.edited : []).slice(0, 200).forEach(function (k) { S.edited[cleanText(k, 40)] = 1; });
    S.pending = (d.pending && /^[0-9A-Za-z-]{8,64}$/.test(str(d.pending.submissionId))) ? {
      submissionId: str(d.pending.submissionId), fingerprint: str(d.pending.fingerprint),
      replaceOrderId: cleanText(d.pending.replaceOrderId, 40), replaceVersion: toInt(d.pending.replaceVersion) >= 1 ? toInt(d.pending.replaceVersion) : 0,
      restored: true
    } : null;
    S.draftCreatedAt = Number(d.createdAt);
    S.restored = true;
    S.hasOcr = !!d.hasOcr;
    S.draftOffer = null;
    revokePhoto();
    renderReview();
  }

  // ===== 作りかけの保存（読み取った項目と進み具合だけ・画像は残さない） =====
  function scheduleSave() {
    if (S.saveTimer) clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(function () { S.saveTimer = 0; saveDraftNow(); }, 700);
  }
  function saveDraftNow() {
    if (!S.open || S.phase !== 'review' || !S.form || !S.me || S.edit) return;
    if (S.saveTimer) { clearTimeout(S.saveTimer); S.saveTimer = 0; }
    var f = S.form;
    var d = {
      key: draftKey(S.me.email), v: 1, email: S.me.email,
      createdAt: S.draftCreatedAt || Date.now(), savedAt: Date.now(),
      form: { pickupTime: f.pickupTime, receptionist: f.receptionist, receiver: f.receiver, requester: f.requester, items: f.items, dateItems: f.dateItems },
      ocrStoreName: S.ocrStoreName, flags: S.flags, edited: Object.keys(S.edited), hasOcr: !!S.hasOcr,
      pending: S.pending ? { submissionId: S.pending.submissionId, fingerprint: S.pending.fingerprint, replaceOrderId: S.pending.replaceOrderId || '', replaceVersion: S.pending.replaceVersion || 0 } : null
    };
    if (draftExpired(d)) {
      // 期限を過ぎた: 書かない。端末に残っている古い分も消す（書く側でも期限を守る）
      draftDelete(S.me.email);
      noteDraftExpired();
      return;
    }
    if (!S.draftCreatedAt) S.draftCreatedAt = d.createdAt;   // 期限は最初に保存した時刻から（手を入れても延ばさない）
    armDraftExpiry(S.me.email, d.createdAt);
    draftPut(d).then(function (ok) {
      if (!ok && !S.draftSaveFailed && S.open) {
        S.draftSaveFailed = true;
        var n = S.els && S.els.wrap.querySelector('[data-step="draft-note"]');
        if (n) n.textContent = 'この端末では作りかけを保存できません（画面を閉じると入力は消えます）。';
      }
    });
  }

  // ===== ③ 確認・修正 =====
  //   並びは申込書と同じ: おせち（1〜19・店渡しと宅配の個数）→ お渡し日を選ぶ商品（27）→ お届け先・ご依頼主 →
  //   お引取り時間 → 店舗名。注意（黄色の帯）は上にまとめる。送信は下の固定の操作。
  function renderReview() {
    if (!S.open) return;
    S.phase = 'review';
    S.lastNote = '';
    S.inputs = {}; S.rows = {};
    var w = S.els.wrap;
    clear(w);
    updateHeader();

    // AI の読み取りであること・写真（修正のときは、直している注文の番号と版）
    var ai = h('div', { 'class': 'osechi-ai' });
    if (S.edit) ai.appendChild(h('div', { 'data-step': 'edit-note', text: '受付番号 ' + S.edit.orderId + '（版 ' + S.edit.version + (S.edit.registeredAt ? '・受付 ' + S.edit.registeredAt : '') + '）の注文を直しています。直したら下の「修正を送る」を押してください。' }));
    else if (S.restored) ai.appendChild(h('div', { text: '作りかけを戻しました。写真は残していないので、注文書を手元で見ながら確かめてください。' }));
    else if (S.hasOcr) ai.appendChild(h('div', { text: 'AI の読み取り結果です（まだ確かめていません）。注文書と見比べて、違う所を直してください。' }));
    else ai.appendChild(h('div', { text: '注文書を見ながら入力してください。' }));
    if (S.photo && S.photo.url) {
      var img = h('img', { 'class': 'osechi-photo osechi-hidden', alt: '撮った注文書' });
      setSafeImageSrc(img, S.photo.url);
      var tbtn = h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-secondary', 'data-act': 'photo-toggle', 'aria-expanded': 'false', text: '📄 撮った写真を見る' });
      tbtn.addEventListener('click', function () {
        var showing = !img.classList.contains('osechi-hidden');
        img.classList.toggle('osechi-hidden', showing);
        tbtn.setAttribute('aria-expanded', showing ? 'false' : 'true');
        tbtn.textContent = showing ? '📄 撮った写真を見る' : '写真をたたむ';
      });
      var big = h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-link', 'data-act': 'photo-big', text: '写真を大きく見る', on: { click: showPhotoBig } });
      add(ai, [h('div', { 'class': 'osechi-btn-row' }, [tbtn]), img, big]);
    }
    ai.appendChild(h('div', { 'class': 'osechi-small', 'data-step': 'draft-note', text: S.edit ? '直している途中の内容は、この端末に残しません（「直さずに戻る」や画面を閉じると消えます）。'   // 修正は作りかけを保存しない（saveDraftNow）
      : S.draftSaveFailed ? 'この端末では作りかけを保存できません（画面を閉じると入力は消えます）。' : '入力の途中は、この端末に12時間だけ残ります（写真は残しません）。' }));
    w.appendChild(ai);

    if (S.pending) {
      w.appendChild(h('div', { 'class': 'osechi-warn', 'data-step': 'pending-note', text: '前回の送信の結果が分かっていません。「この内容で送信」を押すと、同じ注文として送り直します（二重にはなりません）。' }));
    }
    if (S.dropped && S.dropped.length) {
      w.appendChild(h('div', { 'class': 'osechi-warn', 'data-kind': 'dropped', text: '読み取った商品番号 ' + S.dropped.join(', ') + ' は、このアプリで受け付ける商品にありません。注文書を確かめてください（この番号は入れていません）。' }));
    }
    if (S.flags && S.flags.suspicious) {
      w.appendChild(h('div', { 'class': 'osechi-warn', text: 'お渡し日を選ぶ商品の読み取りが不自然です（すべて同じ数・同じ日付など）。注文書とよく見比べてください。' }));
    }
    var band = h('div', { 'data-step': 'warnings-band', 'aria-live': 'polite' });
    S.els.band = band;
    w.appendChild(band);

    // 商品（おせち＝店渡しの数・宅配の数）
    if (S.idx.methodNos.length) {
      var md = commonDates(S.idx.methodNos);
      w.appendChild(h('h3', { 'class': 'osechi-h3', text: 'おせち（店渡しの個数・宅配の個数）' }));
      w.appendChild(h('p', { 'class': 'osechi-note', text: (md ? 'お渡し日・宅配日は ' + md + '。' : '') + '申込書と同じく、店渡しの個数と宅配の個数を分けて入れます（1つの商品で両方に入ることもあります）。' }));
      S.idx.methodNos.forEach(function (no) { w.appendChild(methodRow(no)); });
      w.appendChild(h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-danger', 'data-act': 'clear-method', text: 'おせちの個数をすべて消す', on: { click: function () { onClear('method'); } } }));
    }
    // 商品（お渡し日を選ぶ・2026年は 27 番）
    if (S.idx.dateNos.length) {
      w.appendChild(h('h3', { 'class': 'osechi-h3', text: 'お渡し日を選ぶ商品（注文数 → お渡し日）' }));
      w.appendChild(h('p', { 'class': 'osechi-note', 'data-step': 'date-guide', text: '店渡しの商品です。先に「注文数」（用紙の個数）を入れると、お渡し日が出ます（数が空の商品は「受注なし」）。お渡し日は押して選びます（いくつでも）。2日以上なら、日ごとの個数をお客様に確かめて入れます。' }));
      S.idx.dateNos.forEach(function (no) { w.appendChild(dateRow(no)); });
      w.appendChild(h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-danger', 'data-act': 'clear-date', text: 'お渡し日の商品の入力をすべて消す', on: { click: function () { onClear('date'); } } }));
    }
    if (!S.idx.methodNos.length && !S.idx.dateNos.length) {
      w.appendChild(h('div', { 'class': 'osechi-error', text: '商品の設定がありません。本部へお知らせください（このままでは送れません）。' }));
    }

    // お届け先・ご依頼主（申込書の下段の左と中）
    w.appendChild(h('h3', { 'class': 'osechi-h3', text: 'お届け先・ご依頼主' }));
    w.appendChild(partyBlock('receiver'));
    w.appendChild(partyBlock('requester'));
    w.appendChild(h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-secondary', 'data-act': 'swap', text: 'お届け先 ⇄ ご依頼主 を入れ替える', on: { click: onSwap } }));

    // お引取り時間（申込書の下段の右）
    w.appendChild(h('h3', { 'class': 'osechi-h3', text: 'お引取り時間' }));
    w.appendChild(textField('pickupTime', 'お引取り時間（店渡しのとき・例 16時頃）※宅配は除く', { max: LIMITS.pickupTime }));

    // 店舗名・受付係員（申込書のいちばん下の行）
    w.appendChild(h('h3', { 'class': 'osechi-h3', text: '店舗名・受付係員' }));
    w.appendChild(storeBlock());
    w.appendChild(receptionistField());
    w.appendChild(footNote());

    var sum = h('div', { 'class': 'osechi-sum', 'data-step': 'summary', 'aria-live': 'polite' });
    var msg = h('div', { 'class': 'osechi-small', 'data-step': 'submit-note', 'aria-live': 'polite' });
    var submit = h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-primary', 'data-act': 'submit', text: S.edit ? '修正を送る' : 'この内容で送信' });
    submit.addEventListener('click', onSubmit);
    S.els.submitBtn = submit;
    S.els.submitNote = msg;
    S.els.sumLine = sum;
    setFooter([
      sum, msg, submit,
      S.edit ? h('div', { 'class': 'osechi-btn-row' }, [
        h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-secondary', 'data-act': 'edit-back', text: '直さずに戻る', on: { click: function () { if (!isBusy()) leaveEdit(false); } } }),
        h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-danger', 'data-act': 'cancel-order', text: 'この注文を取り消す', on: { click: onCancelOrder } })
      ]) : h('div', { 'class': 'osechi-btn-row' }, [
        h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-secondary', 'data-act': 'reshoot', text: '撮り直す', on: { click: onReshoot } }),
        h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-danger', 'data-act': 'discard', text: 'この注文をやめる', on: { click: onDiscard } })
      ])
    ]);
    refreshWarningsBand();
    updateSummary();
    updateSubmitState();
    scrollTop();
  }
  /** 商品どうしでお渡し日の候補が同じなら、その日付（例 12/31）。違えば '' */
  function commonDates(nos) {
    var first = null;
    for (var i = 0; i < nos.length; i++) {
      var d = S.idx.byNo[nos[i]].dates.join('・');
      if (first === null) first = d; else if (first !== d) return '';
    }
    return first || '';
  }
  /** 上の黄色の帯: 店名の違い（店の区分）と、窓口の注意（読み取り・似た注文の確認のときに受け取ったもの） */
  function refreshWarningsBand() {
    var band = S.els && S.els.band;
    if (!band || S.phase !== 'review') return;
    clear(band);
    if (isStoreRole()) {
      var paper = S.ocrStoreName;
      var mismatch = (S.flags && S.flags.storeMatched === false && paper) ||
        (paper && normalizeStoreKey(paper) !== normalizeStoreKey(S.me.store) && !(S.flags && S.flags.storeMatched === true));
      if (mismatch) {
        band.appendChild(h('div', { 'class': 'osechi-warn', 'data-kind': 'store-mismatch', text: (S.flags && S.flags.storeMessage) ? S.flags.storeMessage :
          '注文書の店名「' + paper + '」と、この店（' + S.me.store + '）が違います。この店の注文として登録されます。' }));
      }
    }
    var warns = (S.flags && S.flags.warnings) ? S.flags.warnings.filter(function (x) {
      // 日ごとの個数の注意は、まだ空の日があるあいだだけ出す（入れ終われば消える）
      return x.code !== 'DATE_QTY_NEEDED' || dateQtyMissing(x.no);
    }) : [];
    if (warns.length) {
      band.appendChild(h('div', { 'class': 'osechi-warn', 'data-kind': 'warnings' }, [h('b', { text: '注意（確かめてから送ってください）' })].concat(
        warns.map(function (x) { return h('div', { text: '・' + x.message + (BLOCKING_WARNINGS[x.code] ? '（入れるまで送れません）' : '') }); }))));
    }
  }
  /** 選んだお渡し日のうち、個数が空の日がある商品か（no を省くと、どれか1つでも） */
  function dateQtyMissing(no) {
    if (!S.form || !S.idx) return false;
    var nos = (no && S.form.dateItems[no]) ? [no] : S.idx.dateNos;
    return nos.some(function (n) {
      var di = S.form.dateItems[n], sel = selectedDates(di, S.idx.byNo[n].dates);
      if (!dateOrderQty(di).value) return sel.length > 0;   // 日付は読めたが注文数が空
      return sel.length > 1 && sel.some(function (d) { return parseQty(di.sel[d]).empty; });
    });
  }

  function storeBlock() {
    var box = h('div', { 'class': 'osechi-card', 'data-step': 'store' });
    var info = S.flags && S.flags.paper;   // 新しい窓口: 用紙の店名と当たり方（無ければ前の版の窓口＝店舗表の名前だけ）
    if (isStoreRole()) {
      box.appendChild(h('div', { 'class': 'osechi-fixed', 'data-field': 'store' }, [h('span', { text: S.me.store }), h('small', { text: '変更できません' })]));
      var diff = paperStoreDiffers(info, S.flags, S.me.store);
      if (diff) box.appendChild(h('p', { 'class': 'osechi-note', 'data-step': 'store-differs', text: '注文書の店名は「' + diff + '」です。送る前に「異なる店舗の予約ですが良いですか？」と確かめます（この店の注文として登録されます）。' }));
      return box;
    }
    // 本部: 注文書の店名が店の一覧の1店に決まれば、最初から選んである（変えられる）。決まらなければ選ぶ（候補を出す）
    var stores = storeList();
    var paper = info ? info.raw : S.ocrStoreName;
    var cand = info ? (((info.how === 'exact' || info.how === 'similar') && stores.indexOf(info.resolved) >= 0) ? { name: info.resolved } : null)
      : (S.ocrStoreName ? findStoreCandidate(S.ocrStoreName, stores) : null);
    var sel = h('select', { 'class': 'osechi-input', id: 'osechi-f-store', 'data-field': 'store', 'aria-label': 'どの店の注文か' });
    sel.appendChild(h('option', { value: '', text: '— 店を選んでください —' }));
    stores.forEach(function (s) { sel.appendChild(h('option', { value: s, text: s })); });
    sel.value = S.form.store || '';
    var noteBox = h('div', { 'aria-live': 'polite' });
    function refresh() {
      clear(noteBox);
      if (S.storeAuto && S.form.store === S.storeAuto) {
        noteBox.appendChild(h('div', { 'class': 'osechi-info', 'data-step': 'store-auto' }, [
          '注文書の店名「' + paper + '」から ', h('b', { text: S.storeAuto }), ' を選んであります。違うときは、上の一覧から選び直してください。'
        ]));
        return;
      }
      if (paper && cand && S.form.store !== cand.name) {
        noteBox.appendChild(h('div', { 'class': 'osechi-info', 'data-step': 'store-candidate' }, [
          '注文書の店名: 「' + paper + '」 → 候補: ', h('b', { text: cand.name }),
          h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-gold', 'data-act': 'pick-candidate', text: '候補の「' + cand.name + '」を選ぶ',
            on: { click: function () { S.form.store = cand.name; sel.value = cand.name; clearFieldError('store'); refresh(); updateSubmitState(); scheduleSave(); } } })
        ]));
        if (S.form.store) noteBox.appendChild(h('div', { 'class': 'osechi-warn', 'data-step': 'store-differs', text: '注文書の店名（' + paper + '）と、選んだ店（' + S.form.store + '）が違います。よろしいですか？' }));
      } else if (paper && !cand) {
        noteBox.appendChild(h('div', { 'class': 'osechi-warn', 'data-step': 'store-unknown', text: '注文書の店名「' + paper + '」は、店の一覧に見つかりません。注文書を確かめて選んでください。' }));
      } else if (!paper && S.hasOcr) {
        noteBox.appendChild(h('div', { 'class': 'osechi-warn', 'data-step': 'store-unread', text: '注文書の店名が読み取れませんでした。注文書を確かめて選んでください。' }));
      }
    }
    sel.addEventListener('change', function () { S.form.store = sel.value; clearFieldError('store'); refresh(); updateSubmitState(); scheduleSave(); });
    S.inputs.store = sel;
    box.appendChild(h('label', { 'class': 'osechi-label', 'for': 'osechi-f-store', text: S.edit ? 'この注文の店（直すときだけ選び直します）' : 'どの店の注文ですか' }));
    box.appendChild(sel);
    box.appendChild(h('div', { 'class': 'osechi-fieldmsg' }));
    box.appendChild(noteBox);
    refresh();
    return box;
  }

  /** 受付係員（申込書の「受付係員名」）。読めないときは「記載なし」が入っている。押すと全体が選ばれ、打てばそのまま置き換わる */
  function receptionistField() {
    var f = textField('receptionist', '受付係員（申込書のいちばん下・書いていなければ「記載なし」のまま）', { max: LIMITS.receptionist });
    var inp = S.inputs.receptionist;
    inp.addEventListener('focus', function () { if (inp.value === RECEPTIONIST_NONE) { try { inp.select(); } catch (e) { /* 何もしない */ } } });
    // 空にしたまま欄を離れたら「記載なし」に戻す（空のまま送らない）
    inp.addEventListener('change', function () { if (!trim(inp.value)) { inp.value = RECEPTIONIST_NONE; S.form.receptionist = RECEPTIONIST_NONE; scheduleSave(); } });
    return h('div', { 'class': 'osechi-card', 'data-step': 'receptionist' }, f);
  }
  function textField(key, label, opt) {
    opt = opt || {};
    var id = 'osechi-f-' + key.replace(/\./g, '-');
    var input = opt.multiline
      ? h('textarea', { id: id, rows: '2', 'class': 'osechi-input', maxlength: opt.max ? String(opt.max) : null, 'data-field': key, autocomplete: 'off', spellcheck: 'false' })
      : h('input', { id: id, type: opt.type || 'text', 'class': 'osechi-input', maxlength: opt.max ? String(opt.max) : null, inputmode: opt.inputmode || null, 'data-field': key, autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'next' });
    input.value = getField(S.form, key);
    input.addEventListener('input', function () {
      setField(S.form, key, input.value);
      S.edited[key] = 1;
      clearFieldError(key);
      scheduleSave();
    });
    S.inputs[key] = input;
    return h('div', { 'class': 'osechi-field' }, [
      h('label', { 'class': 'osechi-label', 'for': id, text: label }), input, h('div', { 'class': 'osechi-fieldmsg' })
    ]);
  }
  function partyBlock(side) {
    return h('div', { 'class': 'osechi-party', 'data-step': side }, [
      h('div', { 'class': 'osechi-party-title', text: SIDE_LABEL[side] + (side === 'receiver' ? '（宅配のとき）' : '') }),
      textField(side + '.name', 'お名前', { max: LIMITS.name }),
      textField(side + '.zip', '郵便番号', { max: 10, inputmode: 'numeric' }),
      textField(side + '.address', 'ご住所', { max: LIMITS.address, multiline: true }),
      textField(side + '.tel', '電話番号', { max: 24, inputmode: 'tel', type: 'tel' })
    ]);
  }

  function itemBadge(no) {
    var st = statusOf(S.idx, no);
    if (st === 'soldout') return h('span', { 'class': 'osechi-badge osechi-badge-soldout', text: '売切' });
    if (st === 'needcall') return h('span', { 'class': 'osechi-badge osechi-badge-needcall', text: '要電話' });
    return null;
  }
  /** おせちの数量の欄（field: storeQty / deliveryQty） */
  function qtyInput(no, field, label) {
    var it = S.form.items[no], key = 'items.' + no + '.' + field;
    var q = h('input', { type: 'text', inputmode: 'numeric', 'class': 'osechi-qty', maxlength: '2', autocomplete: 'off',
      'aria-label': '商品' + no + 'の' + label, 'data-field': key, enterkeyhint: 'next', placeholder: '－' });
    q.value = it[field];
    q.addEventListener('input', function () {
      it[field] = q.value;
      S.edited[key] = 1;
      updateRow(no);
      scheduleSave();
    });
    S.inputs[key] = q;
    return q;
  }
  function itemNoCell(no, meta) {
    return h('div', { 'class': 'osechi-item-no' }, [h('span', { 'class': 'osechi-item-num', text: String(no) }), meta.name ? h('span', { 'class': 'osechi-item-name', text: meta.name }) : null, itemBadge(no)]);
  }
  /** 店渡しの個数と宅配の個数（申込書の左右の個数欄と同じ並び） */
  function methodRow(no) {
    var meta = S.idx.byNo[no], st = meta.status;
    var qs = qtyInput(no, 'storeQty', '店渡しの個数');
    var qd = qtyInput(no, 'deliveryQty', '宅配の個数');
    var cs = h('label', { 'class': 'osechi-qcell osechi-qcell-store' }, [h('span', { 'class': 'osechi-qlabel', text: '店渡し' }), qs]);
    var cd = h('label', { 'class': 'osechi-qcell osechi-qcell-delivery' }, [h('span', { 'class': 'osechi-qlabel', text: '宅配' }), qd]);
    var msg = h('p', { 'class': 'osechi-item-msg osechi-hidden' });
    var row = h('div', { 'class': 'osechi-item osechi-item-m' + (st === 'needcall' ? ' osechi-item--needcall' : '') + (st === 'soldout' ? ' osechi-item--soldout' : ''), 'data-no': String(no), 'data-kind': 'method' }, [
      itemNoCell(no, meta), cs, cd, msg
    ]);
    S.rows[no] = { row: row, kind: 'method', qtys: [qs, qd], cells: [cs, cd], msg: msg };
    updateRow(no);
    return row;
  }
  /**
   * お渡し日を選ぶ商品（日付型＝27・20〜32）。2026-10-29 PO:「数が空でも日付の欄が出るので、間違って押してしまいそう」
   *   → 先に「注文数」（用紙の個数欄）。注文数が空・0 のあいだは、日付の欄の代わりに「受注なし」と出す（押せる物を出さない）。
   *   注文数を入れると、お渡し日のボタンが出る。日付が1つならその日に注文数・2つ以上なら日ごとの個数を入れる（追補 v3）。
   *   読み取りで日付だけ読めて数が空の行は、黄色で知らせ、注文数を入れるまで送れない（「日付を外す」で受注なしにできる）。
   *   欄の名前: 注文数 dateItems.<no>.total／ボタンの並び dateItems.<no>.dates／日ごとの個数 dateItems.<no>.q.<12-30>
   */
  function dateRow(no) {
    var meta = S.idx.byNo[no], st = meta.status, di = S.form.dateItems[no], tkey = dateOrderKey(no);
    var total = h('input', { type: 'text', inputmode: 'numeric', 'class': 'osechi-qty', maxlength: '2', autocomplete: 'off',
      'aria-label': '商品' + no + 'の注文数', 'data-field': tkey, enterkeyhint: 'next', placeholder: '－' });
    total.value = str(di.hint);
    total.addEventListener('input', function () {
      di.hint = total.value;
      S.edited[tkey] = 1;
      syncSingleDate(di, meta.dates);   // 日付が1つなら、その日の個数＝注文数
      renderDateQtys(no, '');
      updateRow(no);
      scheduleSave();
    });
    // 数を消した（空・0）まま欄を離れた: 選んでいた日付も外す（間違って送られない側。打ち直しの途中では消さない）
    total.addEventListener('change', function () {
      if (dateOrderQty(di).value || !selectedDates(di, meta.dates).length) return;
      di.sel = {};
      S.edited[dateGroupKey(no)] = 1;
      renderDateQtys(no, '');
      updateRow(no);
      scheduleSave();
    });
    S.inputs[tkey] = total;
    var tcell = h('label', { 'class': 'osechi-qcell osechi-dtotal' }, [h('span', { 'class': 'osechi-qlabel', text: '注文数' }), total]);
    var chips = meta.dates.map(function (d) {
      var c = h('button', { type: 'button', 'class': 'osechi-chip', 'data-act': 'date', 'data-no': String(no), value: d, 'aria-pressed': 'false', text: d });
      c.addEventListener('click', function () { toggleDate(no, d); });
      return c;
    });
    var group = h('div', { 'class': 'osechi-chips', role: 'group', 'aria-label': '商品' + no + 'のお渡し日（いくつでも選べます）', 'data-field': dateGroupKey(no) },
      chips.length ? chips : [h('span', { 'class': 'osechi-small', text: 'お渡し日の候補がありません（本部へ）' })]);
    var datesBox = h('div', { 'class': 'osechi-ddates' }, [h('div', { 'class': 'osechi-dhead', text: 'お渡し日（押して選ぶ・いくつでも）' }), group]);
    // 受注なし: 1行だけ（13商品が並んでも画面を長くしない）。何をすれば日付が出るかは、見出しの下の一言と「注文数」の欄で分かる
    var none = h('div', { 'class': 'osechi-dnone', 'data-step': 'date-none', 'aria-label': '受注なし（注文数を入れると、お渡し日を選べます）' }, [h('b', { text: '受注なし' })]);
    var pendText = h('div');
    var pending = h('div', { 'class': 'osechi-dpending osechi-hidden', 'data-step': 'date-pending' }, [pendText,
      h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-link', 'data-act': 'date-clear', 'data-no': String(no), text: '日付を外す（この商品は受注なし）',
        on: { click: function () { if (isBusy()) return; di.sel = {}; S.edited[dateGroupKey(no)] = 1; renderDateQtys(no, ''); updateRow(no); scheduleSave(); } } })]);
    var qbox = h('div', { 'class': 'osechi-dqtys osechi-hidden' });
    var sum = h('div', { 'class': 'osechi-dsum', 'data-step': 'date-sum', 'aria-live': 'polite' });
    var msg = h('p', { 'class': 'osechi-item-msg osechi-hidden' });
    var top = h('div', { 'class': 'osechi-dtop' }, [tcell, h('div', { 'class': 'osechi-dright' }, [none, pending, datesBox])]);
    var col = h('div', { 'class': 'osechi-dcol' }, [top, qbox, sum]);
    var row = h('div', { 'class': 'osechi-item osechi-item-d' + (st === 'needcall' ? ' osechi-item--needcall' : '') + (st === 'soldout' ? ' osechi-item--soldout' : ''), 'data-no': String(no), 'data-kind': 'date' }, [
      itemNoCell(no, meta), col, msg
    ]);
    S.rows[no] = { row: row, kind: 'date', chips: chips, total: total, tcell: tcell, none: none, pending: pending, pendText: pendText, datesBox: datesBox,
      qbox: qbox, sum: sum, msg: msg, qtys: [], cells: [] };
    renderDateQtys(no, '');
    updateRow(no);
    return row;
  }
  /** 日ごとの個数の欄を作り直す（2日以上選んだときだけ。日付の並びは用紙の並び＝候補の順） */
  function renderDateQtys(no, focusDate) {
    var R = S.rows[no], it = S.form.dateItems[no], meta = S.idx.byNo[no];
    if (!R) return;
    Object.keys(S.inputs).forEach(function (k) { if (k.indexOf('dateItems.' + no + '.q.') === 0) delete S.inputs[k]; });
    clear(R.qbox);
    R.qtys = []; R.cells = [];
    var sel = selectedDates(it, meta.dates);
    if (sel.length > 1 && dateOrderQty(it).value) {
      sel.forEach(function (d) {
        var key = dateQtyKey(no, d);
        var q = h('input', { type: 'text', inputmode: 'numeric', 'class': 'osechi-qty', maxlength: '2', autocomplete: 'off',
          'aria-label': '商品' + no + 'の ' + d + ' の個数', 'data-field': key, enterkeyhint: 'next', placeholder: '個数' });
        q.value = str(it.sel[d]);
        q.addEventListener('input', function () {
          if (!hasOwn(it.sel, d)) return;
          it.sel[d] = q.value;
          S.edited[key] = 1;
          updateRow(no);
          scheduleSave();
        });
        var cell = h('label', { 'class': 'osechi-dq' }, [h('span', { 'class': 'osechi-qlabel', text: d + ' の個数' }), q]);
        S.inputs[key] = q;
        R.qtys.push(q);
        R.cells.push({ cell: cell, d: d, input: q });
        R.qbox.appendChild(cell);
        if (focusDate === d) setTimeout(function () { try { q.focus({ preventScroll: true }); } catch (e) { q.focus(); } }, 0);
      });
    }
    R.qbox.classList.toggle('osechi-hidden', !R.qtys.length);
  }
  /** お渡し日のボタンを押した: 選ぶ／外す（注文数が先）。1つ目はその日に注文数・2つ目からは日ごとの個数を入れる */
  function toggleDate(no, d) {
    if (isBusy() || !S.form) return;
    var it = S.form.dateItems[no], meta = S.idx.byNo[no], tq = dateOrderQty(it);
    if (!tq.value) return;   // 受注なし（注文数が空）のあいだは選べない
    if (hasOwn(it.sel, d)) delete it.sel[d];
    else {
      if (meta.status === 'soldout') return;
      it.sel[d] = selectedDates(it, meta.dates).length ? '' : String(tq.value);
    }
    syncSingleDate(it, meta.dates);
    S.edited[dateGroupKey(no)] = 1;
    renderDateQtys(no, hasOwn(it.sel, d) ? d : '');
    updateRow(no);
    scheduleSave();
  }
  /** 行の見た目（青＝数量あり・黄色＝まだ入れる所がある・赤＝直す所。売り切れは数量を入れさせない） */
  function updateRow(no) {
    var R = S.rows[no];
    if (!R) return;
    var st = S.idx.byNo[no].status, text = '', cls = '';
    if (R.kind === 'method') {
      var it = S.form.items[no], fields = ['storeQty', 'deliveryQty'];
      var parsed = fields.map(function (f) { return parseQty(it[f]); });
      var err = parsed.filter(function (q) { return q.error; })[0];
      var hasQty = parsed.some(function (q) { return q.value; });
      // 売り切れ: 空の欄は入れさせない。読み取りで数量が入っていたら消せるように残し、赤で知らせる（黙って消さない）
      R.qtys.forEach(function (input, i) {
        var empty = !str(it[fields[i]]).trim();
        input.disabled = (st === 'soldout' && empty);
        input.setAttribute('placeholder', input.disabled ? '売切' : '－');
        input.classList.toggle('osechi-err', !!parsed[i].error || (st === 'soldout' && !empty));
        if (R.cells[i]) R.cells[i].classList.toggle('osechi-on', !!parsed[i].value);
      });
      if (err) { cls = 'osechi-item--err'; text = '数量: ' + err.error; }
      else if (st === 'soldout' && hasQty) { cls = 'osechi-item--err'; text = '売り切れです。数量を消してください（お客様へのご連絡をお願いします）。'; }
      else if (hasQty) { cls = 'osechi-item--ok'; if (st === 'needcall') text = '要電話確認の商品です。送る前にお客様へ電話で確かめてください。'; }
    } else {
      var di = S.form.dateItems[no], dates = S.idx.byNo[no].dates, sel = selectedDates(di, dates);
      var tq = dateOrderQty(di), locked = !tq.value, total = dateTotal(di, dates), empties = [], derr = '';
      var tEmpty = !str(di.hint).trim();
      R.total.disabled = (st === 'soldout' && tEmpty);
      R.total.setAttribute('placeholder', R.total.disabled ? '売切' : '－');
      R.total.classList.toggle('osechi-err', !!tq.error || (st === 'soldout' && !tEmpty));
      R.tcell.classList.toggle('osechi-on', !!tq.value);
      // 受注なし（注文数が空・0）: 日付のボタンを出さない。日付だけ読めた行は、読めた日付と「日付を外す」を出す
      R.datesBox.classList.toggle('osechi-hidden', locked);
      R.none.classList.toggle('osechi-hidden', !locked || sel.length > 0);
      R.pending.classList.toggle('osechi-hidden', !(locked && sel.length));
      R.pendText.textContent = (locked && sel.length) ? 'お渡し日 ' + sel.join('・') + ' は読めましたが、注文数が空です。' : '';
      R.chips.forEach(function (b) {
        var on = hasOwn(di.sel, b.getAttribute('value'));
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.disabled = (st === 'soldout' && !on);
      });
      R.cells.forEach(function (c) {
        var q = parseQty(di.sel[c.d]);
        if (q.error && !derr) derr = c.d + ' の個数: ' + q.error;
        if (q.empty) empties.push(c.d);
        c.input.classList.toggle('osechi-err', !!q.error || st === 'soldout');
        c.cell.classList.toggle('osechi-on', !!q.value);
      });
      R.sum.textContent = locked ? '' : (sel.length > 1 ? '日ごとの合計 ' + total + ' 個（注文数 ' + tq.value + '）' : (sel.length === 1 ? sel[0] + ' に ' + tq.value + ' 個' : ''));
      R.sum.classList.toggle('osechi-hidden', !R.sum.textContent);
      if (tq.error) { cls = 'osechi-item--err'; text = '注文数: ' + tq.error; }
      else if (derr) { cls = 'osechi-item--err'; text = derr; }
      else if (st === 'soldout' && (tq.value || sel.length)) { cls = 'osechi-item--err'; text = '売り切れです。注文数を消してください（お客様へのご連絡をお願いします）。'; }
      else if (locked && sel.length) { cls = 'osechi-item--warn'; text = '注文書の個数を「注文数」に入れてください（空のままは送れません）。注文しないときは「日付を外す」を押してください。'; }
      else if (!locked && !sel.length) { cls = 'osechi-item--warn'; text = 'お渡し日を選んでください（注文数 ' + tq.value + '）。'; }
      else if (sel.length > 1 && empties.length) { cls = 'osechi-item--warn'; text = empties.join('・') + ' の個数を入れてください（日ごとの個数が空のままは送れません）。'; }
      else if (sel.length > 1 && total !== tq.value) { cls = 'osechi-item--warn'; text = '注文数（' + tq.value + '）と、日ごとの合計（' + total + '）が違います。'; }
      else if (!locked) { cls = 'osechi-item--ok'; if (st === 'needcall') text = '要電話確認の商品です。送る前にお客様へ電話で確かめてください。'; }
      if (!locked && hasOwn(di.sel, NEW_YEAR_DATE) && st !== 'soldout') text = (text ? text + '\n' : '') + NEW_YEAR_DATE + '（元日）は、元日営業の店だけです（そうでない店は、送る前に注意が出ます）。';
    }
    R.row.classList.remove('osechi-item--warn', 'osechi-item--ok', 'osechi-item--err');
    if (cls) R.row.classList.add(cls);
    clear(R.msg);
    add(R.msg, lines(text));
    R.msg.classList.toggle('osechi-hidden', !text);
    if (R.kind === 'date') refreshWarningsBand();
    updateSummary();
  }
  /** 下の操作の上に、入れた数の合計（用紙の合計と見比べるため） */
  function updateSummary() {
    var el = S.els && S.els.sumLine;
    if (!el || !S.form || !S.idx) return;
    var kinds = 0, storeQ = 0, delQ = 0, dateQ = 0;
    S.idx.methodNos.forEach(function (no) {
      var it = S.form.items[no], a = parseQty(it.storeQty).value || 0, b = parseQty(it.deliveryQty).value || 0;
      if (a || b) kinds++;
      storeQ += a; delQ += b;
    });
    S.idx.dateNos.forEach(function (no) {
      var t = 0;
      effectiveDateQtys(S.form.dateItems[no], S.idx.byNo[no].dates).forEach(function (x) { t += x.q; });
      if (t) kinds++;
      dateQ += t;
    });
    var parts = [];
    if (S.idx.methodNos.length) parts.push('店渡し ' + storeQ, '宅配 ' + delQ);
    if (S.idx.dateNos.length) parts.push('日付の商品 ' + dateQ);
    el.textContent = kinds ? parts.join('・') + ' 個（' + kinds + ' 品）' : 'まだ数量の入った商品がありません';
  }
  function syncInputs() {
    // お渡し日の選び方が変わっていたら、日ごとの欄を作り直す（日ごとの欄は2日以上のときだけ）
    Object.keys(S.rows).forEach(function (no) {
      var R = S.rows[no];
      if (R.kind !== 'date') return;
      var di = S.form.dateItems[no], sel = selectedDates(di, S.idx.byNo[no].dates);
      var want = (sel.length > 1 && dateOrderQty(di).value) ? sel.join(',') : '';
      if (want !== R.cells.map(function (c) { return c.d; }).join(',')) renderDateQtys(Number(no), '');
    });
    Object.keys(S.inputs).forEach(function (k) {
      var el = S.inputs[k], v = (k === 'store') ? (S.form.store || '') : getField(S.form, k);
      if (el.value !== v) el.value = v;
    });
    Object.keys(S.rows).forEach(function (no) { updateRow(Number(no)); });
  }
  function fieldElement(key) {
    if (!key || !S.els) return null;
    return S.inputs[key] || S.els.wrap.querySelector('[data-field="' + str(key).replace(/[^A-Za-z0-9_.\-]/g, '') + '"]');
  }
  function focusField(key) {
    var el = fieldElement(key);
    if (!el) return;
    var target = el.closest ? (el.closest('.osechi-item') || el) : el;
    try { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { target.scrollIntoView(); }
    target.classList.remove('osechi-flash');
    void target.offsetWidth;
    target.classList.add('osechi-flash');
    if (el.focus && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') && !el.disabled) {
      try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    }
  }
  function markFieldError(key, message) {
    var el = fieldElement(key);
    if (!el) return;
    if (el.classList.contains('osechi-input') || el.classList.contains('osechi-qty')) el.classList.add('osechi-err');
    var box = el.parentNode && el.parentNode.querySelector('.osechi-fieldmsg');
    if (box) box.textContent = message || '';
  }
  function clearFieldError(key) {
    var el = S.inputs[key];
    if (!el) return;
    el.classList.remove('osechi-err');
    var box = el.parentNode && el.parentNode.querySelector('.osechi-fieldmsg');
    if (box) box.textContent = '';
  }
  function updateSubmitState() {
    var b = S.els && S.els.submitBtn;
    if (!b) return;
    var needStore = !isStoreRole() && !S.form.store;
    b.setAttribute('aria-disabled', needStore ? 'true' : 'false');
    if (S.els.submitNote) S.els.submitNote.textContent = needStore ? '↑ いちばん下の「店舗名」で店を選ぶと送れます（本部は毎回選びます）' : '';
  }
  async function onSwap() {
    if (isBusy()) return;
    if (!await uiConfirm('お届け先とご依頼主の情報を入れ替えます。\nよろしいですか？', { yes: '入れ替える', no: 'やめる' })) return;
    PARTY_FIELDS.forEach(function (f) {
      var t = S.form.receiver[f]; S.form.receiver[f] = S.form.requester[f]; S.form.requester[f] = t;
      S.edited['receiver.' + f] = 1; S.edited['requester.' + f] = 1;
    });
    syncInputs();
    saveDraftNow();
    note('お届け先とご依頼主を入れ替えました。内容を確かめてから送信してください。');
  }
  async function onClear(kind) {
    if (isBusy()) return;
    var label = kind === 'method' ? 'おせちの個数' : 'お渡し日の商品の入力';
    if (!await uiConfirm(label + '（選んだ日付も）を、すべて消します。\nよろしいですか？', { yes: 'すべて消す', no: 'やめる', tone: 'error' })) return;
    (kind === 'method' ? S.idx.methodNos : S.idx.dateNos).forEach(function (no) {
      if (kind === 'method') S.form.items[no] = { storeQty: '', deliveryQty: '' };
      else S.form.dateItems[no] = { sel: {}, hint: '' };
    });
    var keep = S.els.body.scrollTop;
    renderReview();
    S.els.body.scrollTop = keep;
    saveDraftNow();
    note(label + 'を消しました。');
  }
  async function onReshoot() {
    if (isBusy()) return;
    if (!await uiConfirm('いまの入力を捨てて、撮り直しますか？', { yes: '捨てて撮り直す', no: 'やめる', tone: 'error' })) return;
    await discardCurrent();
    renderIntro();
  }
  async function onDiscard() {
    if (isBusy()) return;
    var msg = S.pending ? '前回の送信の結果が分かっていない注文です。\nやめると、受け付けられていたかどうかを、この画面では確かめられなくなります。\nやめてよろしいですか？'
      : 'この注文の入力をすべて捨てます。\nよろしいですか？';
    if (!await uiConfirm(msg, { yes: 'この注文をやめる', no: '入力に戻る', tone: 'error' })) return;
    await discardCurrent();
    S.lastNote = '注文の入力を捨てました。';
    renderIntro();
  }
  async function discardCurrent() {
    S.form = null; S.pending = null; S.flags = null; S.edited = {}; S.restored = false;
    revokePhoto();
    S.phase = 'intro';
    if (S.me) await draftDelete(S.me.email);
  }
  function note(text) { if (S.els && S.els.submitNote) S.els.submitNote.textContent = text; }

  // ===== ④ 似た注文の確認 → ⑤ 送信 =====
  async function onSubmit() {
    if (isBusy() || !S.open || S.phase !== 'review') return;
    var seq = S.seq;
    var btn = S.els.submitBtn;
    btn.disabled = true;                 // 押したらすぐ止める（二重防止の本体は窓口の送信番号）
    try { await submitFlow(seq); }
    finally { if (alive(seq) && S.els.submitBtn === btn) btn.disabled = false; }
  }
  async function submitFlow(seq) {
    if (S.edit) return editFlow(seq);
    if (!isStoreRole() && !S.form.store) {
      markFieldError('store', '店を選んでください');
      await uiAlert('どの店の注文かを選んでください（いちばん下の「店舗名」）。\n本部の方は、送るたびに店を選びます。', 'store', '店を選んでください');
      return;
    }
    // 店・店長: 注文書の店名が自店と違う → 送る前に1回だけ確かめる（PO 2026-10-29。「はい」で自店の注文として登録・この注文書では二度聞かない）
    if (isStoreRole() && !S.storeDiffOk) {
      var diff = paperStoreDiffers(S.flags && S.flags.paper, S.flags, S.me.store);
      if (diff) {
        var ans = await ask({ tone: 'info', title: '異なる店舗の予約ですが良いですか？',
          message: '注文書の店名: ' + diff + '\nこの店: ' + S.me.store + '\n\n「はい」を押すと、この店（' + S.me.store + '）の注文として登録します。',
          buttons: [{ id: 'yes', label: 'はい（この店の注文として登録）', kind: 'primary' }, { id: 'no', label: 'いいえ（戻って確かめる）', kind: 'secondary' }],
          cancelId: 'no' });
        if (!alive(seq)) return;
        if (ans !== 'yes') { note('注文書の店名を確かめてから、もう一度送ってください（ほかの店の注文なら、その店で登録します）。'); focusField('store'); return; }
        S.storeDiffOk = true;
      }
    }
    var ui = {
      alert: function (m, key) { return uiAlert(m, key); },
      confirm: function (m, l) { return uiConfirm(m, l); },
      choose: function (m, buttons, cancelId) { return ask({ tone: 'info', title: '確認', message: m, buttons: buttons, cancelId: cancelId }); },
      focus: function (key) { if (key) focusField(key); },
      changed: function () { syncInputs(); }
    };
    var chk = await runPreSubmitChecks(S.form, { idx: S.idx, role: S.me.role }, ui);
    if (!alive(seq)) return;
    syncInputs();
    saveDraftNow();
    if (!chk.ok) return;

    // 空のままの必須の欄（店渡し＝ご依頼主の電話・宅配＝両方の4欄）。「このまま送る」を明示したときだけ送る
    var missing = chk.missing.slice();
    if (S.flags && S.flags.missing) S.flags.missing.forEach(function (k) { if (missing.indexOf(k) < 0 && !trim(getField(S.form, k))) missing.push(k); });
    var allowMissing = false;
    if (missing.length) {
      var okMissing = await askMissing(missing);
      if (!alive(seq)) return;
      if (!okMissing) { focusField(missing[0]); return; }
      allowMissing = true;
    }

    // 要電話確認
    var needCallConfirmed = false;
    if (chk.needCallNos.length) {
      var nc = await ask({ tone: 'needcall', title: '要電話確認の商品があります',
        message: '商品 ' + chk.needCallNos.join(', ') + ' は「要電話確認」です。\nお客様への電話での確認は済んでいますか？',
        buttons: [{ id: 'ok', label: '電話で確認済みとして進む', kind: 'gold' }, { id: 'back', label: '戻る', kind: 'secondary' }], cancelId: 'back' });
      if (!alive(seq)) return;
      if (nc !== 'ok') { note('要電話確認の商品があるため、送信をやめました。'); return; }
      needCallConfirmed = true;
    }

    var order = buildOrder(S.form, { idx: S.idx, role: S.me.role, store: S.me.store });
    var fp = fingerprint(order);

    // 前回の送信の結果が分からないまま:
    //   ・中身が同じ → 同じ番号で送り直す（前回の確かめのまま。前回が受け付けられていれば、窓口は前回の結果を返す）
    //   ・中身が変わった → 注意・空いている欄は確かめ直す（前回の「確認したうえで送る」を引き継がない＝指摘 M1）。
    //     似た注文の確認はしない（自分の前回分が出る。そこで「別の注文」を選ぶと、前回が受け付けられていたとき二重になる。
    //     本部が店を選び直したときは、前の店に1件・新しい店に1件になる＝指摘 M3）。番号は前回のまま
    //     （前回が受け付けられていれば、窓口は前回の結果を返す＝完了の画面で「直した所は反映されていない」「受付の店」を知らせる）
    var prev = S.pending || null;
    if (prev && prev.fingerprint === fp) {
      prev.needCallConfirmed = needCallConfirmed;
      prev.allowMissing = allowMissing;
      prev.confirmedCodes = chk.confirmedCodes;
      return sendSubmission(seq, prev, order, fp);
    }

    // 似た注文と、窓口の注意
    var replaceOrderId = '', replaceVersion = 0, allowWarnings = false;
    var ac = (typeof AbortController === 'function') ? new AbortController() : null, cancelled = false;
    var layer = startBusy('似た注文がないか確かめています…', { cancelable: true, onCancel: function () { cancelled = true; if (ac) ac.abort(); } });
    var cres;
    try {
      cres = await api('checkOrder', { order: order }, { signal: ac ? ac.signal : null });
    } catch (e) {
      endBusy(layer);
      if (!alive(seq)) return;
      if (cancelled || e.code === 'ABORTED') { note('送信をやめました。'); return; }
      await handleSendError(e, false, order);
      return;
    }
    endBusy(layer);
    if (!alive(seq) || cancelled) return;
    var extraMissing = cleanMissing(cres && cres.flags && cres.flags.missing).filter(function (k) { return missing.indexOf(k) < 0 && !trim(getField(S.form, k)); });
    if (extraMissing.length && !allowMissing) {
      var okMissing2 = await askMissing(extraMissing);
      if (!alive(seq)) return;
      if (!okMissing2) { focusField(extraMissing[0]); return; }
      allowMissing = true;
    }
    // 窓口の注意（取扱いのない店・元日・宅配の地域・宅配のお引取り時間）。黄色の帯にも出し、人が決める
    var warns = cleanWarnings(cres && cres.flags && cres.flags.warnings);
    setWarnings(warns);
    if (warns.length) {
      if (hasBlockingWarning(warns)) { await alertBlocking(warns); return; }
      var toAsk = unconfirmedWarnings(warns, chk.confirmedCodes);
      if (toAsk.length && !await askWarnings(toAsk)) { if (alive(seq)) note('注意があったため、送信をやめました（確かめてから、もう一度送ってください）。'); return; }
      if (!alive(seq)) return;
      allowWarnings = true;
    }
    var sim = cres && cres.similar;
    if (sim && typeof sim === 'object' && !prev) {   // 結果の分からない前回があるときは聞かない（上の説明）
      var choice = await similarDialog(sim);
      if (!alive(seq)) return;
      if (choice === 'cancel') { note('送信をやめました（似た注文があったため）。'); return; }
      if (choice === 'replace') {
        replaceOrderId = cleanText(sim.orderId, 40);
        replaceVersion = toInt(sim.version) >= 1 ? toInt(sim.version) : 0;
      }
    }

    // 1回の操作に1つの番号（「別の注文として受注する」も新しい番号＝別の行。再送だけを同じ番号で1件にする）。
    //   送る前に作りかけへ番号を残す（送信中に端末が画面を終了させても、同じ番号で送り直せる）
    var p;
    if (prev) {
      // 結果の分からない前回の続き: 番号と差し替えの先は前回のまま・確かめはいまの分だけ（fingerprint は前回の中身＝前回の結果が返ったら知らせる）
      p = { submissionId: prev.submissionId, replaceOrderId: prev.replaceOrderId || '', replaceVersion: prev.replaceVersion || 0, needCallConfirmed: needCallConfirmed,
        allowMissing: allowMissing, allowWarnings: allowWarnings, confirmedCodes: chk.confirmedCodes, fingerprint: prev.fingerprint || fp };
    } else {
      p = { submissionId: makeSubmissionId(), replaceOrderId: replaceOrderId, replaceVersion: replaceVersion, needCallConfirmed: needCallConfirmed,
        allowMissing: allowMissing, allowWarnings: allowWarnings, confirmedCodes: chk.confirmedCodes, fingerprint: fp };
    }
    S.pending = p;
    saveDraftNow();
    return sendSubmission(seq, p, order, fp);
  }
  /** まだ人が確かめていない注意（ここで確かめ済みの種類を除く） */
  function unconfirmedWarnings(warns, codes) { return warns.filter(function (w) { return !w.code || (codes || []).indexOf(w.code) < 0; }); }
  /** 窓口から受け取った注意を、上の黄色の帯へ（最新の内容に置き換える） */
  function setWarnings(warns) {
    if (!S.flags) S.flags = { storeMatched: null, storeMessage: '', suspicious: false, missing: [], warnings: [] };
    S.flags.warnings = warns;
    refreshWarningsBand();
    saveDraftNow();
  }
  /** 確認では越えられない注意（日ごとの個数が空）。直す所へ動かす */
  async function alertBlocking(warns) {
    var w = warns.filter(function (x) { return !!BLOCKING_WARNINGS[x.code]; });
    var no = w[0] && w[0].no;
    await uiAlert(w.map(function (x) { return '・' + x.message; }).join('\n') + '\n日ごとの個数を入れてから送ってください（空のままは送れません）。',
      no && S.idx.byNo[no] ? qtyKey(S.idx, no, S.form) : (S.idx.dateNos.length ? dateGroupKey(S.idx.dateNos[0]) : ''), '日ごとの個数を入れてください');
  }
  /** 窓口の注意を見せる。「確認したうえでこのまま送る」なら true */
  async function askWarnings(warns) {
    var wr = await ask({ tone: 'info', title: '注意があります',
      message: warns.map(function (x) { return '・' + x.message; }).join('\n') + '\n\nお客様に確かめたうえで送るときは「確認したうえでこのまま送る」を押してください。',
      buttons: [{ id: 'fix', label: '戻って直す', kind: 'primary' }, { id: 'go', label: '確認したうえでこのまま送る', kind: 'secondary' }], cancelId: 'fix' });
    return wr === 'go';
  }
  async function askMissing(missing) {
    var mr = await ask({ tone: 'info', title: '空いている欄があります',
      message: '次の欄が空いています。\n' + missing.map(function (k) { return '・' + labelOfKey(k); }).join('\n') + '\n\nお客様に確かめて入れてください。分からないまま送るときは「このまま送る」を押してください。',
      buttons: [{ id: 'fix', label: '戻って入れる', kind: 'primary' }, { id: 'send', label: 'このまま送る', kind: 'secondary' }], cancelId: 'fix' });
    return mr === 'send';
  }

  /** 似た注文（昨年の「重複の注文として上書き／別な注文として受注／やめる」を引き継ぐ。どちらも確認つき） */
  async function similarDialog(sim) {
    if (sim.otherStore === true || !cleanText(sim.orderId, 40)) {
      var m = cleanText(sim.message, 200) || '他の店に似た注文があります。お客様に確かめてください。';
      for (;;) {
        var r0 = await ask({ tone: 'info', title: '似た注文があります', message: m + '\n\n別の申込書なら「別の注文として受注する」を選んでください。',
          buttons: [{ id: 'new', label: '別の注文として受注する', kind: 'primary' }, { id: 'cancel', label: 'やめる', kind: 'secondary' }], cancelId: 'cancel' });
        if (r0 !== 'new') return 'cancel';
        if (await uiConfirm('この申込書を「別の注文」として新しく受注します。\nよろしいですか？', { yes: '別の注文として受注する', no: '選び直す' })) return 'new';
      }
    }
    var orderId = cleanText(sim.orderId, 40);
    var score = Number(sim.score);
    var sum = (sim.summary && typeof sim.summary === 'object') ? sim.summary : {};
    var parts = [];
    if (orderId) parts.push('受付番号 ' + orderId);
    if (sum.time) parts.push('受付 ' + cleanText(sum.time, 20));
    if (isFinite(Number(sum.itemsCount))) parts.push('商品 ' + Number(sum.itemsCount) + ' 点');
    if (isFinite(score)) parts.push('似ている度合い ' + Math.round(Math.max(0, Math.min(1, score)) * 100) + '%');
    var same = sim.sameStore === true;
    var buttons = [];
    if (same && orderId && toInt(sim.version) >= 1) buttons.push({ id: 'replace', label: '前の注文に上書きする（差し替え）', kind: 'primary' });
    buttons.push({ id: 'new', label: '別の注文として受注する', kind: same ? 'secondary' : 'primary' });
    buttons.push({ id: 'cancel', label: 'やめる', kind: 'secondary' });
    var msg = '似た内容の注文が、すでに登録されています。\n' + parts.join('\n') +
      (same ? '\n\n同じ申込書の出し直しなら「上書き」、別の申込書なら「別の注文として受注する」を選んでください（1枚の申込書＝1件）。'
            : '\n\nほかの店の注文と似ています（上書きはできません）。別の申込書なら「別の注文として受注する」を選んでください。');
    for (;;) {
      var r = await ask({ tone: 'info', title: '似た注文があります', message: msg, buttons: buttons, cancelId: 'cancel' });
      if (r === 'replace') {
        if (await uiConfirm('前の注文（受付番号 ' + orderId + '）を、この内容で差し替えます（上書き）。\nよろしいですか？', { yes: '上書きする', no: '選び直す' })) return 'replace';
        continue;
      }
      if (r === 'new') {
        if (await uiConfirm('この申込書を「別の注文」として新しく受注します。\nよろしいですか？', { yes: '別の注文として受注する', no: '選び直す' })) return 'new';
        continue;
      }
      return 'cancel';
    }
  }

  /** 送る（1回の操作に1つの番号。再送・自動の送り直し・「もう一度送る」・確認のあとの送り直しでも同じ番号） */
  async function sendSubmission(seq, p, order, fp) {
    p.order = order;
    if (!p.fingerprint) p.fingerprint = fp;
    var payload = {
      submissionId: p.submissionId, order: p.order, needCallConfirmed: !!p.needCallConfirmed,
      editStats: editStats()
    };
    if (p.replaceOrderId) { payload.replaceOrderId = p.replaceOrderId; if (p.replaceVersion) payload.replaceVersion = p.replaceVersion; }
    if (p.allowMissing) payload.allowMissing = true;
    if (p.allowWarnings) payload.allowWarnings = true;
    var layer = startBusy('送信しています…', { sub: '返事が来るまで、この画面のままお待ちください', hold: '送信の返事を待っています。終わるまでお待ちください。' });
    var st = S, res;
    try {
      res = await api('submitOrder', payload);
    } catch (e) {
      endBusy(layer);
      if (!alive(seq)) return;
      // 窓口が「確かめてから」と返した（注意・空いている欄）。登録されていないので、確かめたら同じ番号で送り直す
      if (e.code === 'NEEDS_CONFIRM' || e.code === 'BAD_REQUEST') {
        var w = cleanWarnings(e.warnings), mi = cleanMissing(e.missing);
        if (w.length || mi.length) {
          if (w.length) setWarnings(w);
          if (hasBlockingWarning(w)) { S.pending = null; saveDraftNow(); await alertBlocking(w); return; }
          var go = true;
          if (w.length) { var toAsk = unconfirmedWarnings(w, p.confirmedCodes); go = toAsk.length ? await askWarnings(toAsk) : true; if (go) p.allowWarnings = true; }
          if (go && mi.length) { go = await askMissing(mi); if (go) p.allowMissing = true; }
          if (!alive(seq)) return;
          if (go) return sendSubmission(seq, p, order, fp);
          S.pending = null; saveDraftNow();
          note('送信をやめました（注意・空いている欄を直してから送ってください）。');
          if (mi.length) focusField(mi[0]);
          return;
        }
      }
      if (isDefinitive(e.code)) { S.pending = null; saveDraftNow(); }   // 保存されていないと分かっている＝次は新しい番号
      else saveDraftNow();                                               // 結果が分からない＝同じ番号で送り直す
      await handleSendError(e, !isDefinitive(e.code), order);
      return;
    }
    endBusy(layer);
    if (st.discarded) return;   // 送信中にサインアウトした: 端末に何も書き戻さない（受付は窓口に残る）
    // 店は窓口が受け付けた店（再送で前回の結果が返ったときは、前回の店。送り直す前に選び直した店ではない）
    var sentStore = isStoreRole() ? S.me.store : cleanText(order.store, LIMITS.store);
    var gotStore = cleanText(res && res.store, LIMITS.store) || sentStore;
    var rflags = (res && res.flags && typeof res.flags === 'object') ? res.flags : {};
    var changedAfterAttempt = !!(res && res.replayed && p.fingerprint && fp && p.fingerprint !== fp);
    var result = {
      orderId: cleanText(res && res.orderId, 40), mode: res && res.mode === 'replace' ? 'replace' : 'new',
      replayed: !!(res && res.replayed), store: gotStore, sentStore: sentStore, storeDiffers: !!(sentStore && gotStore !== sentStore),
      changedAfterAttempt: changedAfterAttempt,
      // 受け付けた注文の注意（人が確かめて送ったもの）。前回の結果が返った（いまの直しは書かれていない）ときは、いまの中身の注意なので出さない
      warnings: changedAfterAttempt ? [] : cleanWarnings(rflags.warnings).map(function (w) { return w.message; }).filter(Boolean).slice(0, 5),
      storeMessage: cleanText(rflags.storeMessage, 200)
    };
    if (S.me) draftDelete(S.me.email);
    writeLastDone(result);
    if (!alive(seq)) return;   // 閉じられていた: 作りかけは消し、受付番号は次に開いたときに出す
    S.pending = null;
    renderDone(result);
  }
  function editStats() {
    var s = { edited: Object.keys(S.edited).length, restored: !!S.restored, ocr: !!S.hasOcr };
    if (S.timing.resizeMs != null) s.resizeMs = S.timing.resizeMs;
    if (S.timing.ocrMs != null) s.ocrMs = S.timing.ocrMs;
    if (S.timing.imageKb != null) s.imageKb = S.timing.imageKb;
    return s;
  }
  async function handleSendError(e, canResend, order) {
    var seq = S.seq;
    if (isAuthStop(e)) {
      if (e.code === 'AUTH_DENIED') { showAuthStop(e); return; }   // 使えないアカウント: 作りかけを保存し直さず、消す
      saveDraftNow();
      showAuthStop({ code: e.code, message: e.message + '\n（入力は、この端末に残っています。作ってから12時間で消えます）' });
      return;
    }
    if (e.code === 'SOLD_OUT' || e.code === 'NEED_CALL_UNCONFIRMED') {
      await refreshConfigQuietly();
      if (!alive(seq)) return;
      await uiAlert(e.message + (e.code === 'SOLD_OUT' ? '\n売り切れの商品の数量を消してから、もう一度送ってください。' : '\nもう一度「この内容で送信」を押すと、確認の画面が出ます。'), '', e.code === 'SOLD_OUT' ? '売り切れの商品があります' : '要電話確認の商品があります');
      return;
    }
    if (e.code === 'BAD_REQUEST') {
      if (e.missing && cleanMissing(e.missing).length) {
        S.flags = S.flags || {};
        S.flags.missing = cleanMissing(e.missing);
        await uiAlert('空いている欄があります。\n' + S.flags.missing.map(function (k) { return '・' + labelOfKey(k); }).join('\n') + '\nもう一度「この内容で送信」を押して、入れるか「このまま送る」を選んでください。', S.flags.missing[0]);
        return;
      }
      var key = serverFieldToKey(e.field, order);
      if (key) markFieldError(key, e.message);
      await uiAlert(e.message, key);
      return;
    }
    if (e.code === 'CONFLICT' || e.code === 'NOT_FOUND') {
      await uiAlert(e.message + '\n（似た注文の確認からやり直します。もう一度「この内容で送信」を押してください）', '', e.code === 'CONFLICT' ? 'ほかの人が先に直しました' : '前の注文が見つかりません');
      return;
    }
    if (canResend) {
      note('送信の結果が分かっていません。「もう一度送る」を押してください（二重にはなりません）。');
      var r = await ask({ tone: 'error', title: '送信の返事がありません',
        message: e.message + '\n\n受け付けられたかどうか分かりません。「もう一度送る」を押すと、同じ注文として送り直します（二重にはなりません）。',
        buttons: [{ id: 'resend', label: 'もう一度送る', kind: 'primary' }, { id: 'later', label: 'あとで送る（入力は残します）', kind: 'secondary' }], cancelId: 'later' });
      if (!alive(seq)) return;
      if (r === 'resend' && S.pending) return sendSubmission(seq, S.pending, S.pending.order, fingerprint(S.pending.order));
      if (S.phase === 'review') { var keep = S.els.body.scrollTop; renderReview(); S.els.body.scrollTop = keep; }
      return;
    }
    await uiAlert(e.message, '', e.code === 'CLOSED' ? '受付期間の外です' : '送れませんでした');
  }
  async function refreshConfigQuietly() {
    if (!S.form) return null;
    try {
      var cfg = await api('getConfig');
      if (!S.open || !S.form) return null;
      S.cfg = sanitizeConfig(cfg);
      var oldIdx = S.idx;
      S.idx = buildIndex(S.cfg);
      // 商品の並びが変わったときは、今の入力を新しい並びへ移す（無くなった番号は捨てる）
      var f = emptyForm(S.idx);
      Object.keys(f.items).forEach(function (no) { if (S.form.items[no]) f.items[no] = S.form.items[no]; });
      Object.keys(f.dateItems).forEach(function (no) { if (S.form.dateItems[no]) f.dateItems[no] = S.form.dateItems[no]; });
      f.store = S.form.store; f.pickupTime = S.form.pickupTime; f.receiver = S.form.receiver; f.requester = S.form.requester;
      S.form = f;
      if (S.phase === 'review') { var keep = S.els.body.scrollTop; renderReview(); S.els.body.scrollTop = keep; }
      return oldIdx;
    } catch (e) { return null; }
  }

  // ===== 注文の修正・取消（お客様リストの行から・SPEC §17 updateOrder／cancelOrder） =====
  //   修正の画面は階層2（#osechi-sub）に出し、注文を入れる画面の部品（renderReview）をそのまま使う。
  //   いま入力中の新しい注文（作りかけ）は退避して、修正が終わったら元に戻す。修正の中身は端末に残さない（窓口にある）。
  //   版（version）を持って送る。ほかの人が先に直していたら（CONFLICT）、最新を読み込み直す。
  async function editOrder(orderId, opts) {
    opts = opts || {};
    if (isBusy() || S.edit || !S.open) return false;
    var seq = S.seq;
    try { await S.readyPromise; } catch (e) { return false; }
    if (!alive(seq) || !S.ready) return false;
    var order = await fetchOrderForEdit(orderId);
    if (!order || !alive(seq)) return false;
    openEditor(order, opts);
    return true;
  }
  /** getOrder（読み込み中の表示・断りの案内つき）。読めなければ null */
  async function fetchOrderForEdit(orderId) {
    var layer = startBusy('注文を読み込んでいます…');
    try {
      var r = await api('getOrder', { orderId: cleanText(orderId, 40) });
      endBusy(layer);
      var o = r && r.order;
      if (!o || typeof o !== 'object' || !/^\d{8}-\d{6}$/.test(str(o.orderId)) || !(toInt(o.version) >= 1)) throw new OsechiError('SERVER_ERROR', '', true);
      if (o.status === '取消') { await uiAlert('この注文は取り消されています。', '', '取り消し済みの注文です'); return null; }
      return o;
    } catch (e) {
      endBusy(layer);
      if (isAuthStop(e)) { showAuthStop(e); return null; }
      await uiAlert(e.message, '', e.code === 'NOT_FOUND' ? '注文が見つかりません' : '注文を読み込めませんでした');
      return null;
    }
  }
  function openEditor(order, opts) {
    var st = {
      form: S.form, flags: S.flags, edited: S.edited, pending: S.pending, hasOcr: S.hasOcr, restored: S.restored,
      ocrStoreName: S.ocrStoreName, dropped: S.dropped, draftCreatedAt: S.draftCreatedAt, inputs: S.inputs, rows: S.rows,
      photo: S.photo, phase: S.phase, els: S.els
    };
    S.edit = {
      orderId: cleanText(order.orderId, 40), version: toInt(order.version), store: cleanText(order.store, LIMITS.store),
      registeredAt: cleanText(order.registeredAt, 20), baseline: baselineOf(order), onDone: opts.onDone || null, stash: st, pending: null
    };
    openSub('注文を直す（受付番号 ' + S.edit.orderId + '）', [], { footer: true, onClose: function () { leaveEdit(false); } });
    S.els = Object.assign({}, st.els, { wrap: S.subEls.wrap, body: S.subEls.body, footer: S.subEls.footer, footerIn: S.subEls.footerIn });
    fillEditor(order);
  }
  function fillEditor(order) {
    S.form = formFromOrder(order, S.idx);
    if (isStoreRole()) S.form.store = S.me.store;
    S.flags = null; S.edited = {}; S.pending = null; S.hasOcr = false; S.restored = false;
    S.ocrStoreName = ''; S.dropped = []; S.photo = null;
    S.edit.version = toInt(order.version);
    S.edit.baseline = baselineOf(order);
    S.edit.pending = null;
    S.edit.lostCheck = false;
    S.edit.store = cleanText(order.store, LIMITS.store) || S.edit.store;   // 読み直した注文の店（本部が店を変える確認の基準）
    renderReview();
  }
  /** 修正の画面を閉じて、退避した新しい注文の入力を戻す。changed＝窓口の注文が変わった（一覧を読み直す） */
  function leaveEdit(changed, noteText) {
    var E = S.edit;
    if (!E) return;
    S.edit = null;
    var st = E.stash;
    S.form = st.form; S.flags = st.flags; S.edited = st.edited; S.pending = st.pending; S.hasOcr = st.hasOcr; S.restored = st.restored;
    S.ocrStoreName = st.ocrStoreName; S.dropped = st.dropped; S.draftCreatedAt = st.draftCreatedAt; S.inputs = st.inputs; S.rows = st.rows;
    S.photo = st.photo; S.phase = st.phase; S.els = st.els;
    if (S.sub) { S.sub.onClose = null; closeSub(); }
    S.subEls = null;
    if (E.onDone) { try { E.onDone(!!changed, noteText || ''); } catch (e) { /* 何もしない */ } }
  }
  async function editFlow(seq) {
    var E = S.edit;
    var ui = {
      alert: function (m, key) { return uiAlert(m, key); },
      confirm: function (m, l) { return uiConfirm(m, l); },
      choose: function (m, buttons, cancelId) { return ask({ tone: 'info', title: '確認', message: m, buttons: buttons, cancelId: cancelId }); },
      focus: function (key) { if (key) focusField(key); },
      changed: function () { syncInputs(); }
    };
    if (!isStoreRole() && !S.form.store) {
      await uiAlert('この注文の店を選んでください（「店舗名」）。', 'store', '店を選んでください');
      return;
    }
    var chk = await runPreSubmitChecks(S.form, { idx: S.idx, role: S.me.role, baseline: E.baseline }, ui);
    if (!alive(seq) || S.edit !== E) return;
    syncInputs();
    if (!chk.ok) return;
    var allowMissing = false;
    if (chk.missing.length) {
      if (!await askMissing(chk.missing)) { if (S.edit === E) focusField(chk.missing[0]); return; }
      allowMissing = true;
    }
    var needCallConfirmed = false;
    if (chk.needCallNos.length) {
      var nc = await ask({ tone: 'needcall', title: '要電話確認の商品があります',
        message: '商品 ' + chk.needCallNos.join(', ') + ' は「要電話確認」です（数量を増やした商品）。\nお客様への電話での確認は済んでいますか？',
        buttons: [{ id: 'ok', label: '電話で確認済みとして進む', kind: 'gold' }, { id: 'back', label: '戻る', kind: 'secondary' }], cancelId: 'back' });
      if (nc !== 'ok') { note('要電話確認の商品があるため、送るのをやめました。'); return; }
      needCallConfirmed = true;
    }
    if (!alive(seq) || S.edit !== E) return;
    // 本部が店を選び直した: 別の店の注文へ動くので、確かめてから（新しい注文の「店名が違います」と同じ注意）
    if (!isStoreRole() && S.form.store && E.store && S.form.store !== E.store) {
      var mv = await uiConfirm('この注文の店を「' + E.store + '」から「' + S.form.store + '」に変えます。\n変えると、' + E.store + 'のお客様リストから消え、' + S.form.store + 'のお客様リストに入ります。よろしいですか？',
        { yes: '店を変えて送る', no: 'やめる', title: '店を変えます', tone: 'error' });
      if (!mv || !alive(seq) || S.edit !== E) { if (S.edit === E) note('店を変えずに、送るのをやめました。'); return; }
    }
    var order = buildOrder(S.form, { idx: S.idx, role: S.me.role, store: E.store });
    var fp = fingerprint(order);
    // 1回の操作に1つの番号（通信が切れて送り直しても1回）。窓口の注意・空いている欄の確認のあとも同じ番号。
    //   ただし、結果の分からない修正のあとで中身を直したら、新しい番号（同じ番号だと、窓口は前の修正の結果を返し、いまの直しが黙って消える）。
    //   前の修正が届いていれば版が進んでいる＝版の食い違い（CONFLICT）になり、最新を読み込み直す
    var p = E.pending;
    if (p && p.fingerprint !== fp) { E.lostCheck = true; p = null; }
    if (!p) p = { submissionId: makeSubmissionId(), fingerprint: fp };
    p.allowMissing = allowMissing || !!p.allowMissing;
    p.needCallConfirmed = needCallConfirmed;
    p.confirmedCodes = chk.confirmedCodes;
    E.pending = p;
    return sendUpdate(seq, E, p, order);
  }
  async function sendUpdate(seq, E, p, order) {
    var payload = { orderId: E.orderId, version: E.version, order: order, submissionId: p.submissionId, needCallConfirmed: !!p.needCallConfirmed };
    if (p.allowMissing) payload.allowMissing = true;
    if (p.allowWarnings) payload.allowWarnings = true;
    var layer = startBusy('修正を送っています…', { sub: '返事が来るまで、この画面のままお待ちください', hold: '修正の返事を待っています。終わるまでお待ちください。' });
    var res;
    try {
      res = await api('updateOrder', payload);
    } catch (e) {
      endBusy(layer);
      if (!alive(seq) || S.edit !== E) return;
      if (isAuthStop(e)) { showAuthStop(e); return; }
      if (e.code === 'NEEDS_CONFIRM' || e.code === 'BAD_REQUEST') {
        var w = cleanWarnings(e.warnings), mi = cleanMissing(e.missing);
        if (w.length || mi.length) {
          if (w.length) setWarnings(w);
          if (hasBlockingWarning(w)) { E.pending = null; await alertBlocking(w); return; }
          var go = true;
          if (w.length) { var toAsk = unconfirmedWarnings(w, p.confirmedCodes); go = toAsk.length ? await askWarnings(toAsk) : true; if (go) p.allowWarnings = true; }
          if (go && mi.length) { go = await askMissing(mi); if (go) p.allowMissing = true; }
          if (!alive(seq) || S.edit !== E) return;
          if (go) return sendUpdate(seq, E, p, order);
          E.pending = null;
          note('修正を送るのをやめました（注意・空いている欄を直してから送ってください）。');
          return;
        }
        E.pending = null;
        var key = serverFieldToKey(e.field, order);
        if (key) markFieldError(key, e.message);
        await uiAlert(e.message, key);
        return;
      }
      if (e.code === 'CONFLICT') { E.pending = null; var lost = !!E.lostCheck; E.lostCheck = false; return reloadAfterConflict(seq, E, lost); }
      if (e.code === 'NOT_FOUND') {
        E.pending = null;
        await uiAlert(e.message, '', '注文が見つかりません');
        if (S.edit === E) leaveEdit(true, '');
        return;
      }
      if (isDefinitive(e.code)) {
        E.pending = null;
        if (e.code === 'SOLD_OUT' || e.code === 'NEED_CALL_UNCONFIRMED') await refreshConfigQuietly();
        await uiAlert(e.message, '', e.code === 'CLOSED' ? '受付期間の外です' : '修正を送れませんでした');
        return;
      }
      // 結果が分からない（通信・混雑）: 同じ番号で送り直せる
      var r = await ask({ tone: 'error', title: '返事がありません',
        message: e.message + '\n\n修正が届いたかどうか分かりません。「もう一度送る」を押すと、同じ修正として送り直します（二重にはなりません）。',
        buttons: [{ id: 'resend', label: 'もう一度送る', kind: 'primary' }, { id: 'later', label: 'あとで', kind: 'secondary' }], cancelId: 'later' });
      if (r === 'resend' && alive(seq) && S.edit === E) return sendUpdate(seq, E, p, order);
      return;
    }
    endBusy(layer);
    if (S.edit !== E) return;
    E.pending = null; E.lostCheck = false;
    if (res && res.replayed && p.fingerprint && p.fingerprint !== fingerprint(order)) {
      // 窓口が前の修正の結果を返した（いまの直しは書かれていない）→ 知らせて、最新を読み込み直す（黙って消さない）
      return reloadAfterConflict(seq, E, true);
    }
    var v = toInt(res && res.version);
    leaveEdit(true, '受付番号 ' + E.orderId + ' を直しました' + (v >= 1 ? '（版 ' + v + '）' : '') + '。');
  }
  /** ほかの人が先に直した（CONFLICT）・前の修正が届いていた → 知らせて、最新の内容を読み込み直す（直した所は消える） */
  async function reloadAfterConflict(seq, E, lostEarlier) {
    if (lostEarlier) await uiAlert('返事の届かなかった前の修正が、窓口に届いていました（または、ほかの人が先に直しました）。いまの直しは反映されていません。\n最新の内容を読み込み直します。もう一度直してください。', '', '前の修正が届いていました');
    else await uiAlert('ほかの人が先にこの注文を直しました。最新の内容を読み込み直します（いま直した所は消えます。もう一度直してください）。', '', 'ほかの人が先に直しました');
    if (!alive(seq) || S.edit !== E) return;
    var o = await fetchOrderForEdit(E.orderId);
    if (!alive(seq) || S.edit !== E) return;
    if (!o) { leaveEdit(true, ''); return; }
    fillEditor(o);
    note('最新の内容を読み込み直しました（版 ' + E.version + '）。');
  }
  /** 取消（理由は必須・100字まで。取り消した注文は一覧と集計から消える。理由は窓口の記録にだけ残る） */
  async function onCancelOrder() {
    var E = S.edit;
    if (!E || isBusy()) return;
    var seq = S.seq, reason = '';
    for (;;) {
      var ta = h('textarea', { 'class': 'osechi-input', rows: '3', maxlength: '100', 'data-field': 'cancel-reason', 'aria-label': '取り消す理由', placeholder: '例: お客様から取り消しの連絡（電話）' });
      ta.value = reason;
      ta.setAttribute('data-autofocus', '');   // 最初のフォーカスは理由の欄（「次へ」に置かない＝Enter で進まない）
      var r = await ask({ tone: 'error', title: '注文を取り消す',
        message: '受付番号 ' + E.orderId + ' の注文を取り消します。取り消す理由を入れてください（100字まで・必須）。\n理由は取り消しの記録にだけ残り、お客様リストには出ません。',
        body: h('div', { 'class': 'osechi-field' }, [ta]),
        buttons: [{ id: 'go', label: '理由を入れて次へ', kind: 'danger' }, { id: 'back', label: 'やめる', kind: 'secondary' }], cancelId: 'back' });
      if (r !== 'go' || !alive(seq) || S.edit !== E) return;
      reason = cleanText(ta.value, 100);
      if (reason) break;
    }
    if (!await uiConfirm('受付番号 ' + E.orderId + ' の注文を取り消します。\n取り消した注文は、お客様リストと集計から消えます（元に戻せません）。\nよろしいですか？',
      { yes: '取り消す', no: 'やめる', tone: 'error', title: '取消の確認' })) return;
    if (!alive(seq) || S.edit !== E) return;
    var sid = makeSubmissionId();
    for (;;) {
      var layer = startBusy('取り消しています…');
      try {
        var res = await api('cancelOrder', { orderId: E.orderId, version: E.version, reason: reason, submissionId: sid });
        endBusy(layer);
        if (S.edit !== E) return;
        leaveEdit(true, '受付番号 ' + E.orderId + ' を取り消しました' + (res && res.already ? '（すでに取り消されていました）' : '') + '。');
        return;
      } catch (e) {
        endBusy(layer);
        if (!alive(seq) || S.edit !== E) return;
        if (isAuthStop(e)) { showAuthStop(e); return; }
        if (e.code === 'CONFLICT') return reloadAfterConflict(seq, E);
        if (e.code === 'NOT_FOUND') { await uiAlert(e.message, '', '注文が見つかりません'); if (S.edit === E) leaveEdit(true, ''); return; }
        if (isDefinitive(e.code)) { await uiAlert(e.message, '', e.code === 'CLOSED' ? '受付期間の外です' : '取り消せませんでした'); return; }
        var again = await ask({ tone: 'error', title: '返事がありません', message: e.message + '\n\n取り消しが届いたかどうか分かりません。「もう一度送る」を押すと、同じ取り消しとして送り直します（二重にはなりません）。',
          buttons: [{ id: 'resend', label: 'もう一度送る', kind: 'primary' }, { id: 'later', label: 'あとで', kind: 'secondary' }], cancelId: 'later' });
        if (again !== 'resend' || !alive(seq) || S.edit !== E) return;
      }
    }
  }

  // ===== ⑥ 完了 =====
  function renderDone(r) {
    S.phase = 'done';
    S.lastNote = '';
    S.form = null; S.edited = {}; S.flags = null; S.restored = false;
    revokePhoto();
    var w = S.els.wrap;
    clear(w);
    setFooter(null);
    var card = h('div', { 'class': 'osechi-card', 'data-step': 'done' }, [
      h('div', { 'class': 'osechi-h2', text: r.mode === 'replace' ? '差し替えました' : '受け付けました' }),
      h('div', { 'class': 'osechi-small', text: '受付番号' }),
      h('span', { 'class': 'osechi-done-id', 'data-field': 'orderId', text: r.orderId || '（番号を受け取れませんでした）' }),
      h('p', { 'class': 'osechi-note', text: '店: ' + (r.store || '') + '　／　' + (r.mode === 'replace' ? '前の注文を差し替え' : '新しい注文') }),
      r.replayed ? h('div', { 'class': 'osechi-info', text: '通信が切れる前に、すでに受け付けられていました（同じ注文は1件だけです）。' + (r.changedAfterAttempt ? '送り直す前に直した所は反映されていません。必要なら、お客様リストからこの注文を直してください。' : '') }) : null,
      r.storeDiffers ? h('div', { 'class': 'osechi-warn', 'data-step': 'done-store-differs', text: '受付の店は「' + r.store + '」です（送り直す前に選んだ「' + r.sentStore + '」ではありません）。店を直すときは、お客様リストからこの注文を直してください。' }) : null,
      r.storeMessage ? h('div', { 'class': 'osechi-small', 'data-step': 'done-store-message', text: r.storeMessage }) : null,
      r.warnings && r.warnings.length ? h('div', { 'class': 'osechi-small', 'data-step': 'done-warnings' }, [h('b', { text: '確かめたうえで受け付けた注意: ' })].concat(r.warnings.map(function (m) { return h('div', { text: '・' + m }); }))) : null
    ]);
    var camInput = pickerInput({ type: 'file', accept: 'image/*', capture: 'environment', 'class': 'osechi-file', 'data-act': 'camera-input', tabindex: '-1', 'aria-label': 'カメラで撮影' });
    var next = h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-primary osechi-camera', 'data-act': 'next' }, [
      h('span', { 'class': 'osechi-camera-ico', text: '📷' }), h('span', { text: '次の注文を撮影する' })
    ]);
    next.addEventListener('click', function () { openPicker(camInput); });
    add(card, [next, camInput,
      h('div', { 'class': 'osechi-btn-row' }, [
        h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-secondary', 'data-act': 'to-intro', text: 'はじめの画面へ', on: { click: renderIntro } }),
        h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-secondary', 'data-act': 'close-done', text: '閉じる', on: { click: requestClose } })
      ])
    ]);
    w.appendChild(card);
    w.appendChild(footNote());
    scrollTop();
  }

  // ===== 断り・準備中などの画面 =====
  function renderMessage(m) {
    if (!S.open || !S.els) return;
    S.phase = 'message';
    var w = S.els.wrap;
    clear(w);
    setFooter(null);
    updateHeader();
    w.appendChild(h('div', { 'class': 'osechi-card', 'data-step': 'message', role: 'alert' }, [
      h('div', { 'class': 'osechi-h2', text: m.title || 'お知らせ' }),
      h('div', { 'class': m.tone === 'error' ? 'osechi-error' : 'osechi-info' }, lines(m.text)),
      h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-primary', 'data-act': 'close-message', text: '閉じてホームへ戻る', on: { click: requestClose } })
    ]));
    w.appendChild(footNote());
    scrollTop();
  }

  // ===== 使い方（短く・画面の絵つき）。階層2（#osechi-sub）に出し、戻る操作で閉じる =====
  function showGuide() {
    if (isBusy()) return;
    function step(ico, title, text, mini) {
      return h('li', null, [h('span', { 'class': 'osechi-guide-ico', text: ico }), h('div', null, [h('b', { text: title }), h('div', { 'class': 'osechi-small', text: text }), mini || null])]);
    }
    function mini(labels) { return h('div', { 'class': 'osechi-mini' }, labels.map(function (t) { return h('span', { text: t }); })); }
    var body = h('ol', { 'class': 'osechi-guide-steps', 'data-step': 'guide' }, [
      step('📷', '撮る', '「注文書を撮影して読み取る」を押し、注文書の全体を真上から撮ります。写真なしで手で入れることもできます。'),
      step('✏️', '見比べて直す', 'AI が読んだ内容が出ます。注文書と見比べて違う所を直します。おせちは申込書と同じく「店渡し」と「宅配」の個数を分けて入れます。', mini(['店渡し 2', '宅配 1'])),
      step('📅', 'お渡し日を選ぶ商品', '先に「注文数」（用紙の個数）を入れます。数が空のあいだは「受注なし」と出て、日付は押せません。数を入れると日付が出るので押して選びます（いくつでも）。2日以上なら、日ごとの個数も入れます。', mini(['注文数 3', '12/30 ✓', '12/31 ✓', '12/30 の個数 2'])),
      step('🏬', '店・受付係員', '店のアカウント・店長は自分の店に決まっています。注文書の店名が違うときは、送る前に確かめます。本部の方は、注文書の店名から店が選ばれています（違えば選び直します）。受付係員は、書いていなければ「記載なし」のまま送ります。'),
      step('📨', '送る', '「この内容で送信」を押します。黄色の注意が出たら、お客様に確かめて「確認したうえでこのまま送る」。似た注文があれば「上書き／別の注文として受注する／やめる」を選びます。'),
      step('✅', '受付番号', '受付番号が出たら完了です。続けて「次の注文を撮影する」を押せます。')
    ]);
    var extra = h('div', { 'class': 'osechi-small' }, lines('・1枚の申込書が1件の注文です（同じ内容でも、別の申込書なら「別の注文として受注する」）。\n・売り切れの商品は数量を入れられません。\n・要電話確認の商品は、お客様に電話で確かめてから送ります。\n・入力の途中は、この端末に12時間だけ残ります（写真は残しません）。サインアウトすると消えます。\n・送信を何回押しても、通信が切れて送り直しても、同じ注文は1件だけ登録されます。'));
    // お客様リスト（上の切り替え）の使い方
    var listHead = h('div', { 'class': 'osechi-h2', text: 'お客様リスト' });
    var listBody = h('ol', { 'class': 'osechi-guide-steps', 'data-step': 'guide-list' }, [
      step('📋', '開く', '上の「お客様リスト」を押します。店渡し・宅配・集計を切り替えて見ます。本部の方は、毎回、見る店を選びます。'),
      step('🔍', '探す', '氏名・電話・受付番号で探せます。ひらがな・カタカナ・ローマ字、全角・半角のどれで打っても当たります。空白で区切ると、どの言葉も含む行だけ。漢字の氏名を読み（やまだ）で探すことはできません。', mini(['すずき', 'suzuki', '090-1234'])),
      step('✏️', '直す・取り消す', '行を押すと注文を直せます（「修正を送る」）。取り消すときは、理由を入れます。ほかの人が先に直していたら、最新の内容を読み込み直します。'),
      step('📥', '報告する', '締め日と報告日は上の帯に出ます。報告日は「報告用ファイル（Excel）をダウンロード」か「印刷」。回数に上限があるので、1回押したら終わるまで待ちます。'),
      step('🍣', '受注状況一覧表', '上の「受注状況一覧表」で、受け渡しの日ごと・担当（惣菜・鮮魚・サービスカウンター）ごとに、作る数と、いちばん早い受取の時刻を見られます（お客様の名前は出しません）。印刷は A4 横・1日1ページ、Excel にもできます。')
    ]);
    var listExtra = h('div', { 'class': 'osechi-small', text: '・お客様の氏名・住所・電話は、この端末に残しません。閉じる・店を変える・サインアウトで画面から消えます。' });
    var close = h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-primary', 'data-act': 'guide-close', text: '閉じる', on: { click: function () { closeSub(); } } });
    openSub('おせち受注の使い方', [body, extra, listHead, listBody, listExtra, close]);
  }
  function showPhotoBig() {
    if (!S.photo || !S.photo.url || isBusy()) return;
    var img = h('img', { 'class': 'osechi-photo-big', alt: '撮った注文書' });
    setSafeImageSrc(img, S.photo.url);
    var box = h('div', { 'class': 'osechi-photo-scroll' }, img);
    var zoom = false;
    var zb = h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-secondary', 'data-act': 'photo-zoom', text: '拡大する（指で動かして見ます）' });
    zb.addEventListener('click', function () {
      zoom = !zoom;
      img.style.width = zoom ? '220%' : '100%';
      zb.textContent = zoom ? '画面に合わせる' : '拡大する（指で動かして見ます）';
    });
    openSub('撮った写真', [box, zb]);
  }

  // ===== 管理者（PO）だけ: 件数の確認・帳票の転記 =====
  function adminCard() {
    var out = h('div', { 'aria-live': 'polite' });
    var card = h('div', { 'class': 'osechi-card', 'data-step': 'admin' }, [
      h('div', { 'class': 'osechi-h2', text: '管理者のメニュー' }),
      h('p', { 'class': 'osechi-small', text: '件数・全削除の予定・設定の誤りを確かめます（個人情報は出しません）。' }),
      h('div', { 'class': 'osechi-btn-row' }, [
        h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-secondary', 'data-act': 'admin-status', text: '件数を見る', on: { click: function () { adminRun('adminStatus', out); } } })
      ]),
      out
    ]);
    return card;
  }
  async function adminRun(action, out) {
    if (isBusy()) return;
    var seq = S.seq;
    var layer = startBusy('件数を集めています…');
    try {
      var r = await api(action);
      endBusy(layer);
      if (!alive(seq)) return;
      clear(out);
      out.appendChild(action === 'adminStatus' ? adminStatusView(r) : renderGeneric(r, 0));
    } catch (e) {
      endBusy(layer);
      if (!alive(seq)) return;
      clear(out);
      out.appendChild(h('div', { 'class': 'osechi-error', text: e.message }));
    }
  }
  /** adminStatus（gas/Orders.gs handleAdminStatus_ の形）を表で。知らない形なら、そのまま文字で */
  function adminStatusView(r) {
    var c = r && r.counts, pg = r && r.purge;
    if (!c || typeof c !== 'object') return renderGeneric(r, 0);
    var box = h('div', { 'data-step': 'admin-status' });
    var n = function (v) { var x = toInt(v); return x >= 0 ? String(x) : '?'; };
    box.appendChild(h('div', { 'class': 'osechi-info', text: '有効な注文 ' + n(c.total) + ' 件・取消 ' + n(c.cancelled) + ' 件' + (r.now ? '（' + cleanText(r.now, 20) + ' 時点）' : '') }));
    var byStore = (c.byStore && typeof c.byStore === 'object') ? Object.keys(c.byStore).slice(0, 60) : [];
    if (byStore.length) {
      box.appendChild(h('table', { 'class': 'osechi-table' }, [
        h('thead', null, h('tr', null, [h('th', { text: '店' }), h('th', { text: '件数' })])),
        h('tbody', null, byStore.map(function (k) { return h('tr', null, [h('td', { text: cleanText(k, 40) }), h('td', { text: n(c.byStore[k]) })]); }))
      ]));
    }
    if (pg && typeof pg === 'object') {
      box.appendChild(h('p', { 'class': 'osechi-note', text: '全削除: 予定 ' + (cleanText(pg.planned, 20) || '?') + '・実施 ' + (cleanText(pg.doneAt, 30) || 'まだ') +
        '・毎日の確認 ' + (pg.triggerInstalled === true ? 'あり' : 'なし（installTriggers を実行）') + (toInt(pg.failCount) > 0 ? '・失敗 ' + n(pg.failCount) + ' 回' : '') }));
    }
    var cfg = r.config;
    if (cfg && typeof cfg === 'object') {
      var probs = (Array.isArray(cfg.problems) ? cfg.problems : []).concat(Array.isArray(cfg.warnings) ? cfg.warnings : []).slice(0, 20);
      if (probs.length) box.appendChild(h('div', { 'class': 'osechi-warn' }, [h('b', { text: '設定の誤り・要確認' })].concat(probs.map(function (x) { return h('div', { text: '・' + cleanText(x, 200) }); }))));
    }
    return box;
  }
  /** 窓口の返事を、形を決め打ちせずに文字だけで見せる（深さ・件数に上限） */
  function renderGeneric(v, depth) {
    if (depth > 3) return h('span', { text: '…' });
    if (v == null || typeof v !== 'object') return h('span', { text: cleanText(v, 200) });
    if (Array.isArray(v)) {
      var rows = v.slice(0, 60);
      if (rows.length && rows.every(function (x) { return x && typeof x === 'object' && !Array.isArray(x); })) {
        var cols = Object.keys(rows[0]).slice(0, 6);
        var thead = h('tr', null, cols.map(function (c) { return h('th', { text: cleanText(c, 30) }); }));
        var tb = rows.map(function (x) { return h('tr', null, cols.map(function (c) { return h('td', null, renderGeneric(x[c], depth + 1)); })); });
        return h('table', { 'class': 'osechi-table' }, [h('thead', null, thead), h('tbody', null, tb)]);
      }
      return h('span', { text: rows.map(function (x) { return cleanText(typeof x === 'object' ? JSON.stringify(x) : x, 60); }).join(', ') });
    }
    var dl = h('dl', { 'class': 'osechi-kv' });
    Object.keys(v).filter(function (k) { return k !== 'ok'; }).slice(0, 30).forEach(function (k) {
      dl.appendChild(h('dt', { text: cleanText(k, 40) }));
      dl.appendChild(h('dd', null, renderGeneric(v[k], depth + 1)));
    });
    return dl;
  }

  // ===== 公開（入口は open・close だけ。窓口を呼ぶ関数 api() とは別の名前にする） =====
  var publicApi = Object.freeze({ open: open, close: close, build: OSECHI_UI_BUILD });
  if (hasDom && root && !root.OsechiMode) {
    try { Object.defineProperty(root, 'OsechiMode', { value: publicApi, writable: false, configurable: false, enumerable: true }); }
    catch (e) { /* 定義できない環境では出さない（開けないだけ） */ }
  }
  // Node の試験からだけ中身を使う（ブラウザには出さない）
  if (typeof module === 'object' && module && module.exports) {
    module.exports = {
      OsechiMode: publicApi,
      _test: {
        OSECHI_UI_BUILD: OSECHI_UI_BUILD, SESSION_KEY: SESSION_KEY, DRAFT_DB: DRAFT_DB, DRAFT_TTL_MS: DRAFT_TTL_MS, LAST_DONE_KEY: LAST_DONE_KEY,
        isSameWord: isSameWord, applySameWordAutofill: applySameWordAutofill, hasAnyInfo: hasAnyInfo,
        normalizeStoreKey: normalizeStoreKey, findStoreCandidate: findStoreCandidate, similarity: similarity,
        parseQty: parseQty, normalizeDate: normalizeDate, normalizeTel: normalizeTel, normalizeZip: normalizeZip,
        isValidTel: isValidTel, isValidZip: isValidZip, cleanText: cleanText,
        sanitizeConfig: sanitizeConfig, buildIndex: buildIndex, emptyForm: emptyForm, formFromParsed: formFromParsed, formFromDraft: formFromDraft,
        runPreSubmitChecks: runPreSubmitChecks, buildOrder: buildOrder, findMissing: findMissing, validateFieldFormats: validateFieldFormats, cleanWarnings: cleanWarnings,
        isAllowedApiUrl: isAllowedApiUrl, makeSubmissionId: makeSubmissionId, isDefinitive: isDefinitive,
        createApi: createApi, sanitizeMe: sanitizeMe, draftExpired: draftExpired, OsechiError: OsechiError,
        cleanMissing: cleanMissing, serverFieldToKey: serverFieldToKey, hasBlockingWarning: hasBlockingWarning,
        selectedDates: selectedDates, dateTotal: dateTotal, dateQtyKey: dateQtyKey, dateGroupKey: dateGroupKey,
        getField: getField, setField: setField, formQtyByItem: formQtyByItem, formFromOrder: formFromOrder, baselineOf: baselineOf, listModuleUrl: listModuleUrl, VIEWS: VIEWS, viewsFor: viewsFor, LAYERS: LAYERS, ACTION_OPTS: ACTION_OPTS,
        RESUME_KEY: RESUME_KEY, RESUME_TTL_MS: RESUME_TTL_MS, safeFileName: safeFileName, listModuleProblem: listModuleProblem,
        RESUME_DB: RESUME_DB, parseResumeMark: parseResumeMark, resumeNoteFor: resumeNoteFor,
        sanitizePaperStore: sanitizePaperStore, paperStoreDiffers: paperStoreDiffers, paperStoreAuto: paperStoreAuto,
        dateOrderQty: dateOrderQty, dateOrderKey: dateOrderKey, effectiveDateQtys: effectiveDateQtys, syncSingleDate: syncSingleDate,
        fillOrderQtyFromDates: fillOrderQtyFromDates, RECEPTIONIST_NONE: RECEPTIONIST_NONE
      }
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
