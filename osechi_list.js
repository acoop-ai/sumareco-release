/*
 * osechi_list.js — おせち受注「受注状況」（店渡し・宅配のお客様リスト・集計・店内受注品一覧。SPEC §15・§17・追補 v2・v3／窓口 docs/BACKEND_NOTES.md §6）
 *
 * osechi.js が、上部の切り替えで「受注状況」を開いたときに初めて読み込む（同じ場所・同じ版）。
 *   公開するのは window.OsechiListModule = { build, render(host), dispose(), forget() } だけ（書き換えられない）。
 *   host は osechi.js が渡す道具（api・小窓・処理中・階層2・要素を作る h・注文の修正 editOrder・ファイルの保存 saveFile）。
 *
 * 速さ（2026-10-31 段2.5・窓口の往復は1本 約1.5秒）:
 *   ・店を決めたら openList の1本で、4つの切り替え・印刷・「注文を直す」の中身を受け取る。切り替え・印刷・行を押すのは、窓口へ取りに行かない
 *     （前は切り替えごとに listCustomers・getSummary・getProductionList、行を押すたびに getOrder）
 *   ・修正・取消のあとも一覧を消さない: その行を手元で直し（「直しました（反映を待っています）」の印）、裏で読み直す
 *     （一覧のすぐ上に動く印と「読み込み直しています…」。読み直しの間も押せる・探せる・切り替えられる）
 *   ・同じ画面で開き直した・同じ店を選び直したときは、前に読んだ一覧（ページのメモリ・30分まで）をすぐ出して、裏で読み直す
 *
 * 店の区分（店舗アカウント・店長）は自店だけ（店は選べない）。本部は毎回、店を選ぶ（前回の店を引き継がない）。
 * 個人情報（氏名・住所・電話）は、ページのメモリ（L と、店ごとの最後の一覧 MEM）だけに置く。IndexedDB・localStorage・sessionStorage に入れない。
 *   閉じる・切り替える・店を変えるで dispose（L を捨て、画面と印刷用の領域を消す）。サインアウト・使えないアカウントで forget（MEM も捨てる）。
 * 画面へは host.h（textContent と許可した属性だけ）。HTML を文字で差し込まない（static_safety で機械検査）。
 * ダウンロード（xlsx・CSV）と印刷の記録は回数に上限がある＝自動で送り直さない（osechi.js の ACTION_OPTS）。
 * 切り替えの4つめ「店内受注品一覧」（2026-10-29・REPORT_NOTES §8）: 窓口 openList の production を、そのまま描く
 *   （日・列・担当の組は返事のまま＝画面で決め打ちしない）。個人情報は無い。印刷は A4 横・1日＝1ページ・logPrint {method:'production'}。
 *   Excel は exportProduction（取り出しの上限に数える＝自動で送り直さない）。
 * 本部だけ: 店を選ぶ欄の下の「全店の注文（Excel）をダウンロード」（2026-10-31）＝窓口 exportAllOrders（店を送らない・店の区分にはボタンを作らない）。
 */
(function (root) {
  'use strict';

  var BUILD = 'osechi-ui-2026-10-31a';   // osechi.js の OSECHI_UI_BUILD と同じ値（違えば osechi.js が使わない）
  var STYLE_ID = 'osechi-list-style';
  var PRINT_ID = 'osechi-print';
  var PRINT_ROWS = 15;                   // ひな形の1ページの行数（15行を超えたら「（続き）」）
  var METHOD_LABEL = { store: '店渡し', delivery: '宅配' };
  var METHOD_MARK = { store: '★店渡し', delivery: '☆宅配' };
  // 計画書「7. 中間報告」から短く（連絡先の電話・FAX 番号は出さない。社内の方は「さん」）
  var REPORT_RULES = '報告は別紙の報告書に記入し、ガルーンで送ります（北関東＝関東生鮮惣菜課の栗原さん／首都圏＝首都圏運営課の清田さん）。' +
    '宅配は FAX とガルーンで（報告日）。最終確認は 12/24（木）午前中（申込台帳と申込書の控えを照合）。';
  var DOW = ['日', '月', '火', '水', '木', '金', '土'];
  // 切り替え（順はそのまま画面の並び）。店内受注品一覧は惣菜・鮮魚の担当主任が見る＝お客様の情報の3つの後ろに置く
  var TABS = [['store', '店渡し'], ['delivery', '宅配'], ['summary', '集計'], ['production', '店内受注品一覧']];
  var NONE_MARK = '受注なし';            // 注文の無い商品・日は空白にせず、これを出す（PO 2026-10-29）
  var RECEPTIONIST_NONE = '記載なし';     // 受付係員が空（窓口と同じ言葉）
  // 担当の組の色（xlsx の RPT_PROD_DEPT_FILL_ と同じ色。文字でも担当を書く＝色だけに頼らない）。ほかの値は灰・担当未設定は黄
  var DEPT_CLASS = { '惣菜': 'osechi-prod-ga', '鮮魚': 'osechi-prod-gb', 'サービスカウンター': 'osechi-prod-gc' };   // 色は xlsx の組の見出しと同じ（担当は文字でも書く＝色だけに頼らない）

  // ===== 探す字の直し方: 共通の部品 search_norm.js（weather_pos_analysis/tools/report_base・探す欄の標準 2026-10-14）を、そのまま埋め込む =====
  //   全角半角・カタカナとひらがな・小書き・長音・記号・ローマ字・空白で区切った2語以上 のゆれを吸収する。
  //   漢字の読みの表は渡さない（お客様の氏名の読みは表で持てない＝「やまだ」で「山田」は当たらない）。window には出さない（この中だけで使う）。
  //   直すときは共通の部品の側を直してから、ここへ写す（static_safety が、もとの 19〜229 行目と1字も違わないことを確かめる）。
  var SN = (function () {
    var holder = {};
    // ---- search_norm.js ここから ----
(function(root){
var GRID={'':'あいうえお',k:'かきくけこ',g:'がぎぐげご',s:'さしすせそ',z:'ざじずぜぞ',t:'たちつてと',d:'だぢづでど',n:'なにぬねの',h:'はひふへほ',b:'ばびぶべぼ',p:'ぱぴぷぺぽ',m:'まみむめも',r:'らりるれろ'};
var VW='aiueo',SMALL='ぁぃぅぇぉゃゅょっゎゕゖ',LARGE='あいうえおやゆよつわかけ',YS={a:'ゃ',u:'ゅ',o:'ょ',e:'ぇ'},FS={a:'ぁ',i:'ぃ',e:'ぇ',o:'ぉ'};
var VOW=Object.create(null),ROMA=Object.create(null),VOICED=Object.create(null),SM=Object.create(null),FC=Object.create(null),FCS=Object.create(null);
var WK='\u0004',WOFF=0x800,SMB=0x1000,PW=0xE800,PS=0xF000,SMQ='\u0005',LM='\u0006',LONGC=/[ー\-―−‐]/,KANAC=/[ぁ-ゖァ-ヺ]/,KEEP1=/[0-9a-zぁ-ゖァ-ヶ㐀-䶿一-鿿々〆]/,BOTH=4,KW=[],YOMI=Object.create(null),YF=Object.create(null),YFS=Object.create(null),SEGC=Object.create(null),PC=Object.create(null),ALIAS=Object.create(null),KNOWN=Object.create(null),AGRP=[],YMAX=0,NY=0;
var DROP=/[^0-9a-zぁ-ゖ㐀-䶿一-鿿々〆]/g,KANONLY=/^[㐀-䶿一-鿿々〆]+$/,KAN1=/[㐀-䶿一-鿿々〆]/,SEP='\u0001',BL='\u0002',BR='\u0003',PU=0xE000,CAPK=24,CAPQ=8,EDGE=1,LIT=2,END=8;
(function(){var k,i,v;
 for(k in GRID)for(i=0;i<5;i++){VOW[GRID[k].charAt(i)]=i;ROMA[k+VW.charAt(i)]=GRID[k].charAt(i);}
 VOW['や']=0;VOW['ゆ']=2;VOW['よ']=4;VOW['わ']=0;
 ROMA.ya='や';ROMA.yu='ゆ';ROMA.yo='よ';ROMA.wa='わ';ROMA.wo='を';ROMA.wi='うぃ';ROMA.we='うぇ';
 ROMA.shi='し';ROMA.chi='ち';ROMA.tsu='つ';ROMA.fu='ふ';ROMA.ji='じ';ROMA.thi='てぃ';ROMA.dhi='でぃ';
 for(k in GRID)if(k)for(v in YS)ROMA[k+'y'+v]=GRID[k].charAt(1)+YS[v];
 [['sh','し'],['ch','ち'],['j','じ'],['jy','じ']].forEach(function(x){for(var w in YS)ROMA[x[0]+w]=x[1]+YS[w];});
 for(v in FS){ROMA['f'+v]='ふ'+FS[v];ROMA['v'+v]='ゔ'+FS[v];}
 ROMA.vu='ゔ';
 [['g','k'],['z','s'],['d','t'],['b','h'],['p','h']].forEach(function(x){for(var i=0;i<5;i++)VOICED[GRID[x[0]].charAt(i)]=GRID[x[1]].charAt(i);});
 (SMALL+'ァィゥェォャュョッヮヵヶ').split('').forEach(function(c){SM[c]=1;});})();
// ①: NFKC・小文字・英字の飾り
function pre(s){return String(s).normalize('NFKC').toLowerCase().replace(/[À-ɏ]/g,function(c){return c.normalize('NFD').replace(/[̀-ͯ]/g,'');});}
// ②〜⑤: かなをそろえる（kanaS＝④の小書きだけ、そのまま残す形。字の数は kana と同じ＝小書きの位置を比べるのに使う。上の⑦）
function kanaS(s){
 s=s.replace(/[ァ-ヶヽヾ]/g,function(c){return String.fromCharCode(c.charCodeAt(0)-0x60);});
 s=s.replace(/ゔ([ぁぃぇぉ])/g,function(m,v){return 'ばびべぼ'.charAt('ぁぃぇぉ'.indexOf(v));}).replace(/ゔ/g,'ぶ');
 return s.replace(/ぢ/g,'じ').replace(/づ/g,'ず').replace(/を/g,'お');}
function kana(s){return kanaS(s).replace(/[ぁぃぅぇぉゃゅょっゎゕゖ]/g,function(c){return LARGE.charAt(SMALL.indexOf(c));});}
function fold1(t){return kana(t).replace(DROP,'');}
function folds1(t){return kanaS(t).replace(DROP,'');}
function fold(s){return fold1(pre(s));}
function foldc(s){var v=FC[s];if(v===undefined)v=FC[s]=fold1(s);return v;}   // 言葉ごとに直した字（同じ言葉は、使い回す）
function foldsc(s){var v=FCS[s];if(v===undefined)v=FCS[s]=folds1(s);return v;}
// 小書きの位置（直した字 f と、小書きを残して直した字 s〔同じ長さ〕の、違う所）
function smallOf(f,s){var o=[],i;if(f===s)return o;for(i=0;i<f.length;i++)if(f.charAt(i)!==s.charAt(i))o.push(i);return o;}
// のばす棒の付いた字の位置（①のあとの字 t を直した字〔fold1(t)〕の中の位置。棒＝かなのすぐ後ろの ー・-・―・−・‐）。直したあとに残る字（KEEP1）を数える（ゔ＋小さい母音は1字になる）
function longOf(t){var o=[],n=0,i,c,prev=false;if(!LONGC.test(t))return o;
 for(i=0;i<t.length;i++){c=t.charAt(i);
  if(prev&&n&&LONGC.test(c)){if(o[o.length-1]!==n-1)o.push(n-1);continue;}
  if((c==='ゔ'||c==='ヴ')&&'ぁぃぇぉァィェォ'.indexOf(t.charAt(i+1))>=0){n++;i++;prev=true;continue;}
  if(KEEP1.test(c))n++;prev=KANAC.test(c);}
 return o;}
// 骨の中の、のばす棒の付いた字の位置: 棒の付いた字の位置を骨の中に移し、骨で外した のばす音も、その前の字の棒にする
function skelLong(s,ln){var o=[],gone=0,p=-1,i,c,v,k=0,x;
 for(i=0;i<s.length;i++){c=s.charAt(i);v=VOW[c];
  if(p>=0&&v!==undefined&&c===GRID[''].charAt(v)&&(v===p||(v===2&&p===4))){x=i-gone-1;if(x>=0&&o[o.length-1]!==x)o.push(x);gone++;if(ln[k]===i)k++;continue;}
  if(ln[k]===i){x=i-gone;if(o[o.length-1]!==x)o.push(x);k++;}
  p=(v===undefined)?-1:v;}
 return o;}
// のばす音を外した形（骨）: 同じ母音の重ね（ああ・きい・ゆう）と、お段＋う を外す
function skel(s){return skelCut(s,[]).f;}
// 骨と、言葉の切れ目（骨の中の位置に移す）。cuts は小さい順
function skelCut(s,cuts){var o='',from=0,gone=0,p=-1,i,c,v,b=[],k=0,x;
 for(i=0;i<s.length;i++){
  for(;k<cuts.length&&cuts[k]<=i;k++){x=i-gone;if(x&&b[b.length-1]!==x)b.push(x);}
  c=s.charAt(i);v=VOW[c];
  if(p>=0&&v!==undefined&&c===GRID[''].charAt(v)&&(v===p||(v===2&&p===4))){o+=s.slice(from,i);from=i+1;gone++;continue;}
  p=(v===undefined)?-1:v;}
 o+=s.slice(from);
 while(b.length&&b[b.length-1]>=o.length)b.pop();
 return {f:o,b:b};}
// 字の位置（小書きの位置。小さい順）を、骨の中の位置に移す（外した字の位置は、落とす）
function skelPos(s,pos){var o=[],gone=0,p=-1,i,c,v,k=0;
 for(i=0;i<s.length&&k<pos.length;i++){c=s.charAt(i);v=VOW[c];
  if(p>=0&&v!==undefined&&c===GRID[''].charAt(v)&&(v===p||(v===2&&p===4))){gone++;if(pos[k]===i)k++;continue;}
  if(pos[k]===i){o.push(i-gone);k++;}
  p=(v===undefined)?-1:v;}
 return o;}
// ローマ字 → かな（読めない所があれば null）
function romaji(s){var o='',i=0,n=s.length,c,d,e,j,w;
 while(i<n){c=s.charAt(i);d=s.charAt(i+1);
  if(c==='-'){o+='ー';i++;continue;}
  if(c==="'"){i++;continue;}
  if(c==='n'){
   if(d==="'"){o+='ん';i+=2;continue;}
   if(d==='n'){e=s.charAt(i+2);o+='ん';i+=(e&&'aiueoy'.indexOf(e)>=0)?1:2;continue;}
   if(!d||'aiueoy'.indexOf(d)<0){o+='ん';i++;continue;}}
  if(c==='m'&&d&&'bp'.indexOf(d)>=0){o+='ん';i++;continue;}
  if(d&&c===d&&'aiueon'.indexOf(c)<0){o+='っ';i++;continue;}
  if(c==='t'&&s.substr(i+1,2)==='ch'){o+='っ';i++;continue;}
  w='';for(j=4;j>0;j--)if(ROMA[s.substr(i,j)]){w=s.substr(i,j);break;}
  if(!w)return null;
  o+=ROMA[w];i+=w.length;}
 return o;}
// 言葉に分ける（①のあとの字）: 〔字, 種類〕の並び。種類＝K 漢字・H ひらがな・T カタカナ・A 英数。空白・記号で切れる。長音・小書き・濁点の印は、前のかなに付く（J）
function kind(c){var x=c.charCodeAt(0);
 if((x>=0x3400&&x<=0x4DBF)||(x>=0x4E00&&x<=0x9FFF)||x===0x3005||x===0x3006)return 'K';
 if(SM[c]||x===0x30FC||(x>=0x3099&&x<=0x309E)||x===0x30FD||x===0x30FE)return 'J';
 if(x>=0x3041&&x<=0x3096)return 'H';
 if(x>=0x30A1&&x<=0x30FA)return 'T';
 if((x>=0x30&&x<=0x39)||(x>=0x61&&x<=0x7A))return 'A';
 return '';}
function toks(t){var out=[],last=null,i,c,k;
 for(i=0;i<t.length;i++){c=t.charAt(i);k=kind(c);
  if(k==='J'){if(last&&(last[1]==='H'||last[1]==='T')){last[0]+=c;continue;}
   if(!SM[c]){last=null;continue;}
   k=c.charCodeAt(0)<0x30A0?'H':'T';}
  if(!k){last=null;continue;}
  if(last&&last[1]===k){last[0]+=c;continue;}
  last=[c,k];out.push(last);}
 return out;}
// 漢字の並び1つを、読みのかたまりに分ける: 表にあれば、そのまま。無ければ、長い方から当てて区切る（当たらない字は、漢字のまま）
function seg(run){var out=SEGC[run],i=0,n=run.length,j,w,hit;
 if(out)return out;
 if(YOMI[run])return (SEGC[run]=[[run,YOMI[run]]]);
 out=[];
 while(i<n){hit='';for(j=Math.min(YMAX,n-i);j>0;j--){w=run.substr(i,j);if(YOMI[w]){hit=w;break;}}
  if(hit){out.push([hit,YOMI[hit]]);i+=hit.length;}
  else{if(out.length&&!out[out.length-1][1])out[out.length-1][0]+=run.charAt(i);else out.push([run.charAt(i),null]);i++;}}
 return (SEGC[run]=out);}
// 読みのかたまり（漢字の並び run・直した読み y）の中の、言葉の切れ目: run を、表にある並び（run そのものは除く）に分けて、読みが y に頭からそろう分け方を探す。
//   2つめより後ろの並びは、頭の1字の濁り（連濁）を許す。表に無い並びは、1か所だけ許す（北海道｜噴火湾｜産）。表に無い字の少ない分け方 → 並びの少ない分け方 を選ぶ。
//   表に無い並びが1字なら、その両側は弱い切れ目（上の④。冷‖凍・黒‖糖）。
//   分けた並びのうち3字以上のものは、表にある2字以上の並びだけで分けられれば、さらに分ける（砂糖不使用低脂肪 → 砂糖不使用｜低脂肪 → 砂糖｜不使用｜低脂肪。1字には分けない＝冷凍・北海道 は分けない）。返す: y の中の切れ目の位置
function fit(y,p,r,mid){if(y.substr(p,r.length)===r)return true;
 return mid&&p+r.length<=y.length&&VOICED[y.charAt(p)]===r.charAt(0)&&y.substr(p+1,r.length-1)===r.slice(1);}
function splitRun(run,y){var out=[];if(run.length>=2)deeper(run,y,0,0,parts(run,y,false,false),out);return out.sort(function(a,b){return a[0]-b[0];});}
// 分け方1つ: 返す〔〔run の中の位置, y の中の位置〕…〕（切れ目・小さい順）。mid0＝1番めの並びにも、頭の濁りを許す／only2＝表にある2字以上の並びだけで分ける（表に無い並びも使わない）
function parts(run,y,mid0,only2){var n=run.length,m=y.length,L=[],R=[],i,j,p,q,a,rs,x,best=null,u,c,out=[],lo=only2?2:1;
 for(i=0;i<=n;i++){L.push([]);R.push([]);}
 L[0][0]={c:0};
 for(i=0;i<n;i++)for(p=0;p<=m;p++){if(!L[i][p])continue;
  for(j=i+lo;j<=n;j++){if(i===0&&j===n)continue;rs=YF[run.slice(i,j)];if(!rs)continue;
   for(a=0;a<rs.length;a++)if(rs[a]&&fit(y,p,rs[a],i>0||mid0)){q=p+rs[a].length;x=L[i][p].c+1;if(!L[j][q]||x<L[j][q].c)L[j][q]={c:x,i:i,p:p};}}}
 if(L[n][m])best={u:0,c:L[n][m].c,i:n,p:m};
 else if(!only2){R[n][m]={c:0};
  for(j=n;j>0;j--)for(q=m;q>=0;q--){if(!R[j][q])continue;
   for(i=j-1;i>=0;i--){if(i===0&&j===n)continue;rs=YF[run.slice(i,j)];if(!rs)continue;
    for(a=0;a<rs.length;a++){p=q-rs[a].length;if(rs[a]&&p>=0&&fit(y,p,rs[a],i>0||mid0)){x=R[j][q].c+1;if(!R[i][p]||x<R[i][p].c)R[i][p]={c:x,j:j,q:q};}}}}
  for(i=0;i<n;i++)for(p=0;p<=m;p++){if(!L[i][p])continue;
   for(j=i+1;j<=n;j++){if(i===0&&j===n)continue;u=j-i;
    for(q=p+1;q<=m;q++){if(!R[j][q])continue;c=L[i][p].c+1+R[j][q].c;
     if(!best||u<best.u||(u===best.u&&c<best.c))best={u:u,c:c,i:i,p:p,j:j,q:q};}}}}
 if(!best)return out;
 u=best.u===1;
 for(i=best.i,p=best.p;L[i][p].c>0;){if(i<n)out.unshift([i,p,u&&i===best.i]);x=L[i][p];i=x.i;p=x.p;}
 if(best.u)for(j=best.j,q=best.q;j<n;){out.push([j,q,u&&j===best.j]);x=R[j][q];j=x.j;q=x.q;}
 return out;}
// 切れ目 c で分けた並びを、y の中の切れ目として out に足し、3字以上の並びは、2字以上の並びだけで、さらに分ける（i0・p0＝run・y の、かたまりの中での頭の位置）
function deeper(run,y,i0,p0,c,out){var a=0,p=0,k,b,q;if(!c.length)return;
 for(k=0;k<=c.length;k++){b=k<c.length?c[k][0]:run.length;q=k<c.length?c[k][1]:y.length;
  if(k<c.length)out.push([p0+q,!!c[k][2]]);
  if(b-a>=3)deeper(run.slice(a,b),y.slice(p,q),i0+a,p0+p,parts(run.slice(a,b),y.slice(p,q),i0+a>0,true),out);
  a=b;p=q;}}
// 表にある並び run の、読みごとの言葉の並び（〔〔言葉…〕, 〔小書きを残した言葉…〕〕の並び。読みの順）
function readings(run){var v=PC[run];
 if(!v)v=PC[run]=YF[run].map(function(y,n){var ys=YFS[run][n],c=splitRun(run,y),o=[],q=[],i,s=0,w=false;for(i=0;i<c.length;i++){o.push((w?WK:'')+y.slice(s,c[i][0]));q.push((w?WK:'')+ys.slice(s,c[i][0]));s=c[i][0];w=c[i][1];}o.push((w?WK:'')+y.slice(s));q.push((w?WK:'')+ys.slice(s));return [o,q];});
 return v;}
// 形の並び（どれも、言葉ごとに直した字の並び w・小書きを残した同じ並び s と、読みを入れた形か r）: 〔もとの字の形, 読みを入れた形（どの並びも1番めの読み）, ほかの読みの組み合わせ…〕。組み合わせが cap を超えるときは、1か所だけ替えた形にとどめる
//   言葉の頭の WK＝その前は弱い切れ目（上の④）。表に無い並びを、1字の並びが続く所で区切ったとき（日‖東）も、弱い切れ目にする
//   ks＝鍵の側（読みを入れた形には小書きの印を付けないので、小書きを残した並びを作らない）
function variants(t,cap,ks){var tk=toks(t),f=[],fs=[],lit=[],lits=[],slots=[],glue=[],multi=[],total=1,any=false,out,idx,carry,a,i,j,g,ch,sel;
 for(i=0;i<tk.length;i++){f.push(g=foldc(tk[i][0]));fs.push(foldsc(tk[i][0]));if(g){lit.push(g);lits.push(fs[i]);}}
 if(!NY)return [{w:lit,s:lits,r:0}];
 for(i=0;i<tk.length;i++){
  if(tk[i][1]!=='K'){if(f[i])slots.push([[[f[i]],[fs[i]]]]);continue;}
  ch=seg(tk[i][0]);
  for(j=0;j<ch.length;j++){if(ch[j][1]){any=true;slots.push(readings(ch[j][0]));}else slots.push([[[ch[j][0]],[ch[j][0]]]]);
   if(j&&ch[j][0].length===1&&ch[j-1][0].length===1)glue[slots.length-1]=1;}}
 if(!any)return [{w:lit,s:lits,r:0}];
 function make(sel){var w=[],s=[],k,x,y,h;for(k=0;k<slots.length;k++){x=slots[k][sel?sel[k]:0];for(y=0;y<x[0].length;y++)if(x[0][y]){h=glue[k]&&!y?WK:'';w.push(h+x[0][y]);if(!ks)s.push(h+x[1][y]);}}return {w:w,s:ks?w:s,r:1};}
 function zero(){return slots.map(function(){return 0;});}
 for(i=0;i<slots.length;i++)if(slots[i].length>1){multi.push(i);total*=slots[i].length;}
 out=[{w:lit,s:lits,r:0},make(null)];
 if(total+1<=cap){idx=multi.map(function(){return 0;});
  for(;;){carry=true;for(a=0;a<multi.length&&carry;a++){idx[a]++;if(idx[a]<slots[multi[a]].length)carry=false;else idx[a]=0;}
   if(carry)break;sel=zero();for(a=0;a<multi.length;a++)sel[multi[a]]=idx[a];out.push(make(sel));}}
 else for(a=0;a<multi.length&&out.length<cap;a++)for(j=1;j<slots[multi[a]].length&&out.length<cap;j++){sel=zero();sel[multi[a]]=j;out.push(make(sel));}
 return out;}
function cutsOf(w){var b=[],k=[],n=0,i,x;for(i=0;i<w.length;i++){x=w[i];if(x.charAt(0)===WK){x=x.slice(1);if(i)k.push(n);}else if(i)b.push(n);n+=x.length;}return {b:b,k:k};}
function joinw(w){return w.join('').split(WK).join('');}
// 当てる形の並び {f: 字, b: 言葉の切れ目, wb: 弱い切れ目, sm: 小書きの位置, ln: のばす棒の付いた字の位置, r: 読みを入れた形か}: そのままの形と、骨（のばす音を外した形）。min＝骨を入れる、いちばん短い長さ（鍵の側は 2・探す字の側は 3。短い骨〔とうふ → とふ〕は、関係ない字に当たりすぎる）
//   kk＝鍵の側（読みを入れた形の、小書き・のばす棒の印は、使わないので出さない）
function forms(vs,min,kk){var seen=Object.create(null),out=[],i,f,c,s,sm,ln,x;
 for(i=0;i<vs.length;i++){f=joinw(vs[i].w);if(!f)continue;c=cutsOf(vs[i].w);x=kk&&vs[i].r;sm=x||vs[i].s===vs[i].w?[]:smallOf(f,joinw(vs[i].s));ln=x?[]:(vs[i].ln||[]);
  if(!seen[f]){seen[f]=1;out.push({f:f,b:c.b,wb:c.k,sm:sm,ln:ln,r:vs[i].r});}
  s=skelCut(f,c.b);if(s.f!==f&&s.f.length>=min&&!seen[s.f]){seen[s.f]=1;out.push({f:s.f,b:s.b,wb:skelCut(f,c.k).b,sm:sm.length?skelPos(f,sm):[],ln:x?[]:skelLong(f,ln),r:vs[i].r});}}
 return out;}
// 鍵（探される字の側）: そのままの形・読みを入れた形・それぞれの骨 を、SEP でつないだ字。形のうしろに、切れ目の印（読みを入れた形は BR・ほかは BL のあとに、切れ目の位置を1字ずつ・弱い切れ目は PW から・小書きは PS から・のばす棒は LM のあとに PU から〔小書きと棒は、読みを入れた形には付けない〕）
function enc(x){var sm=x.r?[]:(x.sm||[]),ln=x.r?[]:(x.ln||[]),m=x.r?BR:(x.b.length||x.wb.length||sm.length||ln.length?BL:''),i;for(i=0;i<x.b.length;i++)m+=String.fromCharCode(PU+x.b[i]);for(i=0;i<x.wb.length;i++)m+=String.fromCharCode(PW+x.wb[i]);for(i=0;i<sm.length;i++)m+=String.fromCharCode(PS+sm[i]);if(ln.length){m+=LM;for(i=0;i<ln.length;i++)m+=String.fromCharCode(PU+ln[i]);}return x.f+m;}
function key(text){var t=pre(text),vs=variants(t,CAPK,true);vs[0].ln=longOf(t);return forms(vs,2,true).map(enc).join(SEP);}
// 探す語（打った字の側）: 空白で区切った語ごとに、当てる形の並び（そのまま・読み・ローマ字 → かな・別の書き方）。どの語も、どれかの形で当たれば、当たり
//   形の頭に、当て方の印（0x10＋印）: LIT＝もとの字の形にだけ・小書きも合うときだけ（上の②・⑥・⑦・⑨）／EDGE＝はしが切れ目にそろうときだけ（上の③）／BOTH＝両はしが切れ目にそろうときだけ（上の⑤・⑧）／END＝終わりのはしが切れ目にそろうときだけ（上の⑧の連濁）
//   LIT の形のうしろに、SMQ と小書きの位置（PS＋位置）
function altsOf(w){var kan=KANONLY.test(w),one=kan&&w.length===1,y0=one&&YF[w]?YF[w][0]:'',out=[],seen=Object.create(null),n0,j,g,r,f,more;
 function put(f,sm,ln,fl,al){var z,i;if(seen[f])return;
  if((kan||al)&&!KAN1.test(f)){if(one&&f.length<2)return;fl|=LIT|(one&&!al&&f.length===2&&f!==y0?(y0.length===2&&f.charAt(1)===y0.charAt(1)&&VOICED[f.charAt(0)]===y0.charAt(0)?END:BOTH):f.length+(al?ln.length:0)<=2?EDGE:0);}   // 別の書き方の形は、のばす棒も1字に数える（バター＝3字）
  seen[f]=1;z=fl?String.fromCharCode(0x10+fl)+f:f;
  if((fl&LIT)&&(sm.length||ln.length)){z+=SMQ;for(i=0;i<sm.length;i++)z+=String.fromCharCode(PS+sm[i]);if(ln.length){z+=LM;for(i=0;i<ln.length;i++)z+=String.fromCharCode(PU+ln[i]);}}
  out.push(z);}
 forms(variants(w,CAPQ),3).forEach(function(x){put(x.f,x.sm,[],0,false);});
 if(/^[a-z][a-z'\-]+$/.test(w)){r=romaji(w);if(r&&/[^んっー]/.test(r)){f=fold1(r);more=f.length<=2&&!KNOWN[f]?longs(f):[];
  forms([{w:[f],s:[f],r:0}],3).forEach(function(x){put(x.f,[],[],more.length&&x.f===f?BOTH:0,false);});
  more.forEach(function(x){put(x,[],[],0,false);});}}
 n0=out.length;
 for(j=0;j<n0;j++){g=ALIAS[plain(out[j])];if(g!==undefined)AGRP[g].forEach(function(m){var p=pre(m);forms([{w:[fold1(p)],s:[folds1(p)],ln:longOf(p),r:0}],3).forEach(function(x){put(x.f,x.sm,x.ln,0,true);});});}   // 別の書き方は、その字のまま当てる（漢字を、読みに広げない。かなの形は⑨＝もとの字の形にだけ）
 return out;}
// のばす音を落とした、短いローマ字の形（tofu → とふ）に、「う」を1つ足した形のうち、表にある言葉（とうふ）
function longs(f){var out=[],i,v,e;
 for(i=0;i<f.length;i++){v=VOW[f.charAt(i)];if((v===2||v===4)&&f.charAt(i+1)!=='う'){e=f.slice(0,i+1)+'う'+f.slice(i+1);if(KNOWN[e]&&out.indexOf(e)<0)out.push(e);}}
 return out;}
function flagOf(x){var c=x.charCodeAt(0);return c>=0x10&&c<0x20?c-0x10:0;}
function plain(x){var y=flagOf(x)?x.slice(1):x,t=y.indexOf(SMQ);return t<0?y:y.slice(0,t);}
function terms(q){var ws=pre(q).split(/\s+/),out=[],i,a;for(i=0;i<ws.length;i++){if(!ws[i])continue;a=altsOf(ws[i]);if(a.length)out.push(a);}return out;}
// 鍵 k の中で、形 x が、上の①〜⑨のとおりに当たる所（無ければ −1）。鍵は、いくつかの鍵を SEP でつないだものでもよい
function at(k,x){var fl=flagOf(x),q=fl?x.slice(1):x,t=q.indexOf(SMQ),qs='',ql='',n,p,s,e,m,c,a,b,st,en,cr,j,v,ok,ks,kl,lm,li=fl&LIT;
 if(t>=0){qs=q.slice(t+1);q=q.slice(0,t);t=qs.indexOf(LM);if(t>=0){ql=qs.slice(t+1);qs=qs.slice(0,t);}}
 n=q.length;p=k.indexOf(q);
 while(p>=0){e=k.indexOf(SEP,p);if(e<0)e=k.length;
  for(m=p+n,c=0;m<e;m++){c=k.charCodeAt(m);if(c===2||c===3)break;}
  if(!((fl&LIT)&&m<e&&c===3)){
   s=k.lastIndexOf(SEP,p)+1;a=p-s;b=a+n;st=a===0;en=p+n===m;cr=false;ks='';kl='';lm=false;
   for(j=m+1;j<e;j++){c=k.charCodeAt(j);if(c===6){lm=true;continue;}v=c-PU;
    if(lm){if(ql&&v>=a&&v<b)kl+=String.fromCharCode(PU+v-a);}else if(v>=SMB){v-=SMB;if(li&&v>=a&&v<b)ks+=String.fromCharCode(PS+v-a);}else if(v>=WOFF){v-=WOFF;if(v>a&&v<b)cr=true;}else if(v===a)st=true;else if(v===b)en=true;else if(v>a&&v<b)cr=true;}
   ok=(fl&BOTH)?st&&en:(fl&END)?(cr?st&&en:en):(fl&EDGE)?(cr?st&&en:st||en):(!cr||st||en);
   if(ok&&(fl&LIT)&&ks!==qs)ok=false;
   if(ok&&ql)for(j=0;j<ql.length;j++)if(kl.indexOf(ql.charAt(j))<0){ok=false;break;}
   if(ok&&(fl&LIT)&&KW.length&&inWord(k.slice(s,m),a,b))ok=false;
   if(ok)return p;}
  p=k.indexOf(q,p+1);}
 return -1;}
// 当たった所のはし（a・b）が、かなの言葉の表（KW）の言葉の途中にあるか（t＝もとの字の形）
function inWord(t,a,b){var i,w,o;
 for(i=0;i<KW.length;i++){w=KW[i];for(o=t.indexOf(w);o>=0;o=t.indexOf(w,o+1))if((a>o&&a<o+w.length)||(b>o&&b<o+w.length))return true;}
 return false;}
function hit(k,Q){var i,j,a,ok;if(typeof Q==='string')Q=terms(Q);
 for(i=0;i<Q.length;i++){a=Q[i];ok=false;for(j=0;j<a.length;j++)if(at(k,a[j])>=0){ok=true;break;}if(!ok)return false;}
 return true;}
// 当たった所を、もとの字で示すための直し方（1かたまりずつ直して、もとの字の位置を持つ）。見せる分だけに使う（鍵を作るのには、使わない）
//   かたまり＝1字と、その後ろに付く字（濁点・半濁点の印／ヴ のあとの小さい母音）。言葉の切れ目は、鍵と同じ作り方（variants）から写し、当てるのも鍵と同じ at
function chunkEnd(text,i){var j=i+1,c=text.charAt(i);
 while(j<text.length&&'ﾞﾟ゙゚゛゜'.indexOf(text.charAt(j))>=0)j++;
 if('ヴゔ'.indexOf(c)>=0||(c==='ｳ'&&j>i+1)){if(j<text.length&&'ァィェォぁぃぇぉｧｨｪｫ'.indexOf(text.charAt(j))>=0)j++;}
 return j;}
function plainMap(text,a,b,o){var i=a,j,d,ds,x,p;while(i<b){j=Math.min(chunkEnd(text,i),b);p=pre(text.slice(i,j));d=fold1(p);ds=o.sm?folds1(p):d;
  if(o.ln&&!d&&o.kana&&o.k.length&&LONGC.test(p.charAt(0))){if(o.ln[o.ln.length-1]!==o.k.length-1)o.ln.push(o.k.length-1);}else o.kana=KANAC.test(p.charAt(p.length-1));
  for(x=0;x<d.length;x++){if(d.charAt(x)!==ds.charAt(x))o.sm.push(o.k.length);o.k+=d.charAt(x);o.s.push(i);o.e.push(j);}i=j;}}
function skelMap(o){var r={k:'',s:[],e:[],b:skelCut(o.k,o.b).b,wb:skelCut(o.k,o.wb).b,sm:o.sm?skelPos(o.k,o.sm):null,ln:o.ln?skelLong(o.k,o.ln):null,r:o.r},p=-1,i,c,v;
 for(i=0;i<o.k.length;i++){c=o.k.charAt(i);v=VOW[c];
  if(p>=0&&'あいうえお'.indexOf(c)>=0&&(v===p||(c==='う'&&p===4))){if(r.e.length)r.e[r.e.length-1]=o.e[i];continue;}
  r.k+=c;r.s.push(o.s[i]);r.e.push(o.e[i]);p=(v===undefined)?-1:v;}
 return r;}
function maps(text){var lit={k:'',s:[],e:[],b:[],wb:[],sm:[],ln:[],kana:false,r:0},rd={k:'',s:[],e:[],b:[],wb:[],sm:null,ln:null,r:1},any=false,last=0,m,out,c,vs=variants(pre(text),2),re=/[㐀-䶿一-鿿々〆]+/g;
 plainMap(text,0,text.length,lit);
 if(lit.k===joinw(vs[0].w)){c=cutsOf(vs[0].w);lit.b=c.b;lit.wb=c.k;}
 if(NY){
  while((m=re.exec(text))){plainMap(text,last,m.index,rd);var from=m.index;
   seg(m[0]).forEach(function(g){var en=from+g[0].length,d,x;
    if(g[1]){any=true;d=fold(g[1][0]);for(x=0;x<d.length;x++){rd.k+=d.charAt(x);rd.s.push(from);rd.e.push(en);}}else plainMap(text,from,en,rd);
    from=en;});
   last=m.index+m[0].length;}
  plainMap(text,last,text.length,rd);
  if(vs[1]&&rd.k===joinw(vs[1].w)){c=cutsOf(vs[1].w);rd.b=c.b;rd.wb=c.k;}}
 out=[lit,skelMap(lit)];if(any){out.push(rd);out.push(skelMap(rd));}
 return out;}
function locate(text,Q){var f,i,j,p,k,a;if(typeof Q==='string')Q=terms(Q);if(!Q.length)return null;a=Q[0];f=maps(String(text));
 for(i=0;i<f.length;i++){k=enc({f:f[i].k,b:f[i].b,wb:f[i].wb,sm:f[i].sm,ln:f[i].ln,r:f[i].r});
  for(j=0;j<a.length;j++){p=at(k,a[j]);if(p>=0)return [f[i].s[p],f[i].e[p+plain(a[j]).length-1]];}}
 return null;}
// 表を渡す: yomi＝{漢字の並び: '読み/読み'}／alias＝〔〔語, 別の書き方…〕…〕／word＝〔かなの言葉…〕（上の⑥）。何回呼んでも、足されるだけ。KNOWN＝表にある言葉（読みと、別の書き方の形。直した字）
function load(d){var k,v;if(!d)return;
 if(d.yomi)for(k in d.yomi){v=d.yomi[k];v=(typeof v==='string'?v.split('/'):v).filter(function(x){return !!x;});if(!v.length)continue;if(!YOMI[k])NY++;YOMI[k]=v;YF[k]=v.map(fold1);YFS[k]=v.map(folds1);YF[k].forEach(function(y){KNOWN[y]=1;});if(k.length>YMAX)YMAX=k.length;}
 SEGC=Object.create(null);PC=Object.create(null);
 if(d.alias)d.alias.forEach(function(g){var n=AGRP.length;AGRP.push(g);g.forEach(function(m){var vs=variants(pre(m),CAPQ);vs.forEach(function(v){KNOWN[joinw(v.w)]=1;});forms(vs,2).forEach(function(x){if(ALIAS[x.f]===undefined)ALIAS[x.f]=n;});});});
 if(d.word)d.word.forEach(function(w){var f=fold(w);if(f&&KW.indexOf(f)<0)KW.push(f);});}
root.SearchNorm={key:key,terms:terms,hit:hit,locate:locate,fold:fold,skel:skel,romaji:romaji,load:load,maps:maps,count:function(){return {yomi:NY,alias:AGRP.length,word:KW.length};}};
})(holder);
    // ---- search_norm.js ここまで ----
    return holder.SearchNorm;
  })();

  // ===== 部品（DOM を使わない＝Node で試験できる） =====
  function str(v) { return v == null ? '' : String(v); }
  function nfkc(s) { s = str(s); try { return s.normalize('NFKC'); } catch (e) { return s; } }
  function toInt(v) { var n = Number(v); return (isFinite(n) && Math.floor(n) === n) ? n : NaN; }
  // 制御文字・向きを変える文字（表示のなりすましに使われる）を除く。osechi.js の CTRL_RE と同じ決まり（static_safety が照合）
  var CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;
  function cleanText(v, max) {
    var s = str(v).replace(/[\r\n\t]+/g, ' ').replace(CTRL_RE, '').trim();
    return max && s.length > max ? s.slice(0, max) : s;
  }
  // 壊れた応答で画面を重くしない上限（全体の行・探す語の字数）。1つの店の店渡し＋宅配の行は、多い店でも千行ほど（全店で5千件前後）
  //   ＝5000 行を超える返事は壊れている。超えた分は描かず「報告用ファイル（Excel）で見てください」
  var TOTAL_ROWS_MAX = 5000, SEARCH_MAX = 100;
  function searchLimit(s) { return str(s).slice(0, SEARCH_MAX); }
  /** 検索語が空か（空白だけも空） */
  function searchText(s) { return nfkc(searchLimit(s)).replace(/\s+/g, ''); }
  /** 探すための数字（電話・郵便・受付番号）: 数字だけ */
  function searchDigits(s) { return nfkc(s).replace(/\D+/g, ''); }
  /** 検索語を、語ごとの当て方に（打つたびに1回だけ作る）: 字は共通の部品の当て方・数字は3桁以上で電話・郵便・受付番号に当てる */
  function parseQuery(q) {
    return nfkc(searchLimit(q)).split(/\s+/).filter(function (w) { return !!w; }).map(function (w) { return { terms: SN.terms(w), digits: searchDigits(w) }; });
  }
  /** 行の鍵（行を受け取ったときに1回だけ作る）: 氏名・住所は共通の部品の鍵／電話・郵便・受付番号は数字だけ */
  function rowKeys(r) {
    var parties = [r.receiver, r.requester];
    return {
      key: SN.key(parties.map(function (p) { return p.name + ' ' + p.address; }).join(' ')),
      digits: [r.orderId].concat(parties.map(function (p) { return p.tel + ' ' + p.zip; })).map(searchDigits).join('|')
    };
  }
  /** 行が検索語に当たるか（どの語も、氏名・住所か、数字で当たる＝2語以上は、どれも含む行） */
  function rowMatchesQ(row, pq) {
    if (!row.keys) row.keys = rowKeys(row);
    return pq.every(function (w) {
      if (w.terms.length && SN.hit(row.keys.key, w.terms)) return true;
      return w.digits.length >= 3 && row.keys.digits.indexOf(w.digits) >= 0;
    });
  }
  function rowMatches(row, q) { return rowMatchesQ(row, parseQuery(q)); }
  /** 窓口の行を、画面で使う形に掃除する（知らない項目は捨てる・文字は長さで切る） */
  function cleanParty(p) {
    p = (p && typeof p === 'object') ? p : {};
    return { zip: cleanText(p.zip, 12), tel: cleanText(p.tel, 24), address: cleanText(p.address, 200), name: cleanText(p.name, 60) };
  }
  function cleanRow(r) {
    r = (r && typeof r === 'object') ? r : {};
    var c = {
      n: toInt(r.n) >= 1 ? toInt(r.n) : 0, page: toInt(r.page) >= 0 ? toInt(r.page) : 0, receivedAt: cleanText(r.receivedAt, 20),
      orderId: /^\d{8}-\d{6}$/.test(str(r.orderId)) ? str(r.orderId) : '', version: toInt(r.version) >= 1 ? toInt(r.version) : 0,
      qty: toInt(r.qty) >= 0 ? toInt(r.qty) : 0, receiver: cleanParty(r.receiver), requester: cleanParty(r.requester),
      receptionist: cleanText(r.receptionist, 20) || RECEPTIONIST_NONE   // 受付係員（追補 v6）。空なら「記載なし」（窓口と同じ）
    };
    // 探すための鍵は、受け取ったときに1回だけ作る（打つたびに作り直さない）。受付係員は鍵に入れない
    //   （お店の人の名字＝お客様の名字と同じことが多い。お客様を探すと、その人が受けた注文まで当たって探せなくなる）
    c.keys = rowKeys(c);
    return c;
  }
  function loadedRows(blocks) { return blocks.reduce(function (s, b) { return s + b.rows.length; }, 0); }
  /** 検索語で絞る（当たる行のあるブロックだけ）。検索語が空なら、そのまま */
  function filterBlocks(blocks, q) {
    if (!searchText(q)) return blocks.map(function (b) { return { block: b, rows: b.rows }; });
    var pq = parseQuery(q);
    return blocks.map(function (b) { return { block: b, rows: b.rows.filter(function (r) { return rowMatchesQ(r, pq); }) }; })
      .filter(function (x) { return x.rows.length; });
  }
  /** base64 → バイトの並び（壊れていれば例外） */
  function base64ToBytes(b64) {
    var s = str(b64).replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) throw new Error('受け取ったファイルの形が正しくありません');
    var bin = (typeof atob === 'function') ? atob(s) : Buffer.from(s, 'base64').toString('binary');
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  /** xlsx（zip）の始まり 'PK' か */
  function isZipBytes(bytes) { return !!(bytes && bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B); }
  /** 'yyyy/MM/dd' → 'M/D（曜）'（日本の暦の日付として・端末の時刻帯に左右されない） */
  function mdDow(ymd) {
    var m = str(ymd).match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    if (!m) return str(ymd);
    var d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return Number(m[2]) + '/' + Number(m[3]) + '（' + DOW[d.getUTCDay()] + '）';
  }
  /** 印刷のページ（数量のある商品だけ・15行ごとに「（続き）」・番号は続き番号） */
  function printPages(blocks, rowsPerPage) {
    var per = rowsPerPage || PRINT_ROWS, pages = [];
    blocks.forEach(function (b) {
      if (!b.rows.length) return;
      for (var i = 0; i < b.rows.length; i += per) {
        pages.push({ no: b.no, title: b.title + (i ? '（続き）' : ''), continued: i > 0, startNo: i + 1, rows: b.rows.slice(i, i + per) });
      }
    });
    return pages;
  }
  /**
   * 集計（getSummary の summary）→ 表の形。method: 'store'｜'delivery'。
   *   rows（締め日の行）: 今日より先の行は空欄（null）・0 は空欄。合計行＝最新の累計（窓口の total）。途中経過（pending）は別の行
   */
  function summaryTable(summary, store, method) {
    var s = (summary && typeof summary === 'object') ? summary : {};
    var by = (s.byStore && typeof s.byStore === 'object') ? (s.byStore[store] || s.all) : s.all;
    var t = (by && by[method] && typeof by[method] === 'object') ? by[method] : null;
    var items = (Array.isArray(s.items) ? s.items : []).map(function (it) {
      return { no: toInt(it.no), label: str(it.headName1 || it.name).slice(0, 20), sub: str(it.headName2).slice(0, 20) };
    });
    var cell = function (v) { var n = toInt(v); return n > 0 ? n : ''; };
    var rows = (Array.isArray(s.rows) ? s.rows : []).map(function (r, i) {
      var vals = t && Array.isArray(t.rows) ? t.rows[i] : null;
      return {
        closing: str(r.closing), report: str(r.report), filled: r.filled === true, inProgress: r.inProgress === true,
        cells: Array.isArray(vals) ? items.map(function (_, k) { return cell(vals[k]); }) : items.map(function () { return ''; }),
        total: Array.isArray(vals) && t.rowTotals ? cell(t.rowTotals[i]) : ''
      };
    });
    var sumOf = function (arr) { return (Array.isArray(arr) ? arr : []).reduce(function (a, v) { return a + (toInt(v) > 0 ? toInt(v) : 0); }, 0); };
    var totalRow = t && Array.isArray(t.total) ? { cells: items.map(function (_, k) { return cell(t.total[k]); }), total: cell(t.totalSum) } : null;
    var ip = toInt(s.inProgressRow);
    var pendingRow = (t && Array.isArray(t.pending) && ip >= 0 && s.rows && s.rows[ip])
      ? { closing: str(s.rows[ip].closing), cells: items.map(function (_, k) { return cell(t.pending[k]); }), total: cell(sumOf(t.pending)) } : null;
    return { items: items, rows: rows, totalRow: totalRow, pendingRow: pendingRow };
  }
  /** サンド（getSummary の sandwich）→ 自店の列の日付ごとの数 */
  function sandwichRows(sw) {
    sw = (sw && typeof sw === 'object') ? sw : {};
    var stores = Array.isArray(sw.stores) ? sw.stores : [];
    var si = -1;
    stores.forEach(function (st, i) { if (si < 0 && st && st.name === sw.onlyStore) si = i; });
    var dates = Array.isArray(sw.dates) ? sw.dates : [];
    var rows = dates.map(function (d, i) {
      var g = Array.isArray(sw.grid) && Array.isArray(sw.grid[i]) ? sw.grid[i] : [];
      var v = si >= 0 ? toInt(g[si]) : NaN;
      return { date: str(d), qty: v > 0 ? v : '' };
    });
    var total = si >= 0 && Array.isArray(sw.storeTotals) ? toInt(sw.storeTotals[si]) : NaN;
    return { label: si >= 0 ? str(stores[si].label || stores[si].name) : '', rows: rows, total: total > 0 ? total : (rows.length ? 0 : ''),
      notOpenNewYear: Array.isArray(sw.notOpenNewYear) ? sw.notOpenNewYear.length : 0 };
  }
  /** 締め日の帯（getSummary の deadline）→ { main, sub, today } */
  function deadlineView(dl) {
    dl = (dl && typeof dl === 'object') ? dl : null;
    if (!dl) return null;
    var next = (dl.next && typeof dl.next === 'object') ? dl.next : null;
    var main = next ? '次の締め日 ' + mdDow(next.closing) + ' → 報告 ' + mdDow(next.report) : (dl.afterLast ? '締め日はすべて過ぎました' : str(dl.message).slice(0, 120));
    var today = dl.isReportDay === true;
    var sub = today ? '本日は報告日です' + (dl.todayReport && dl.todayReport.closing ? '（' + mdDow(dl.todayReport.closing) + '〆の分）' : '') + '。報告書をダウンロードして送ってください。'
      : (dl.afterLast ? '最終確認は 12/24（木）午前中です。' : '');
    return { main: main, sub: sub, today: today };
  }

  // ---- 店内受注品一覧（getProductionList の production）: 部品（DOM を使わない） ----
  //   壊れた応答で画面を重くしない上限。今年は 6日・3組・1日に最大13商品・列は時台＋3つ
  var PROD_MAX = { slots: 40, days: 40, groups: 12, items: 80, out: 30, warns: 10 };
  var SLOT_KINDS = { hour: 1, am: 1, pm: 1, none: 1 };
  function own(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function objOf(v) { return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }
  function listOf(v, max) { return (Array.isArray(v) ? v : []).slice(0, max); }
  function count0(v) { var n = toInt(v); return n >= 0 ? n : 0; }
  /**
   * 窓口の production を、画面で使う形に掃除する（知らない項目は捨てる・文字は長さで切る・数は 0 以上の整数）。
   *   列（slots）・日（days）・担当の組（groups）・商品（items）の並びは返事のまま（決め打ちしない）。
   *   商品の列ごとの個数は、slots と同じ並びの cells に移す（列の名前を、そのまま入れ物の名前にしない）。
   *   「受注なし」は数から決める（個数が 0 の商品・どの商品も受注なしの組と日）＝画面の表示と食い違わない。
   */
  function cleanProduction(p) {
    p = objOf(p);
    var seen = Object.create(null), slots = [];
    listOf(p.slots, PROD_MAX.slots).forEach(function (s) {
      s = objOf(s);
      var key = cleanText(s.key, 20);
      if (!key || seen[key]) return;
      seen[key] = 1;
      slots.push({ key: key, kind: own(SLOT_KINDS, s.kind) ? s.kind : 'none', label: cleanText(s.label, 24) || key });
    });
    var zero = function () { return slots.map(function () { return 0; }); };
    var days = listOf(p.days, PROD_MAX.days).map(function (d) {
      d = objOf(d);
      var groups = listOf(d.groups, PROD_MAX.groups).map(function (g) {
        g = objOf(g);
        var items = listOf(g.items, PROD_MAX.items).map(function (it) {
          it = objOf(it);
          var by = objOf(it.bySlot), qty = count0(it.qty);
          var none = it.noOrders === true || !(qty > 0);
          return { no: toInt(it.no) >= 1 ? toInt(it.no) : 0, name: cleanText(it.name, 80), qty: none ? 0 : qty, noOrders: none,
            orderCount: count0(it.orderCount), earliest: none ? '' : cleanText(it.earliest, 12), assumedQty: count0(it.assumedQty),
            cells: none ? zero() : slots.map(function (s) { return own(by, s.key) ? count0(by[s.key]) : 0; }) };
        });
        var unassigned = g.unassigned === true;
        return { dept: cleanText(g.dept, 20), label: cleanText(g.label, 20) || (unassigned ? '担当未設定' : '担当'), unassigned: unassigned,
          orderCount: count0(g.orderCount), noItems: !items.length, noOrders: items.every(function (x) { return x.noOrders; }), items: items };
      });
      var date = cleanText(d.date, 10);
      return { date: date, ymd: /^\d{4}\/\d{2}\/\d{2}$/.test(str(d.ymd)) ? str(d.ymd) : '', label: cleanText(d.label, 20) || date,
        orderCount: count0(d.orderCount), closedNewYear: d.closedNewYear === true, noOrders: groups.every(function (g) { return g.noOrders; }), groups: groups };
    }).filter(function (d) { return !!d.date; });
    return {
      asOf: cleanText(p.asOf, 20), storeLabel: cleanText(p.storeLabel, 40), orderCount: count0(p.orderCount), timeNote: cleanText(p.timeNote, 400),
      noItems: p.noItems === true || !days.length, slots: slots, days: days,
      outOfCandidates: listOf(p.outOfCandidates, PROD_MAX.out).map(function (e) {
        e = objOf(e);
        return { no: toInt(e.no) >= 1 ? toInt(e.no) : 0, name: cleanText(e.name, 80), date: cleanText(e.date, 20), qty: count0(e.qty), orderCount: count0(e.orderCount) };
      }),
      warnings: listOf(p.warnings, PROD_MAX.warns).map(function (w) {
        w = objOf(w);
        return { code: cleanText(w.code, 30), message: cleanText(w.message, 160), count: count0(w.count) };
      }).filter(function (w) { return !!w.message; })
    };
  }
  /** はじめに見せる日: いつの時点（asOf・窓口の時計）の日か、それより後のいちばん早い日。どれも過ぎていれば最後の日 */
  function defaultProdDay(m) {
    if (!m || !m.days.length) return '';
    var t = (str(m.asOf).match(/^\d{4}\/\d{2}\/\d{2}/) || [''])[0];
    if (!t) return m.days[0].date;
    var hit = m.days.filter(function (d) { return d.ymd && d.ymd >= t; })[0];
    return (hit || m.days[m.days.length - 1]).date;
  }
  /** 列の見出し（xlsx と同じ）: 1段目は固定の4つ＋「受取の時刻ごとの個数（個）」、2段目は slots の名前（返事の順のまま） */
  var PROD_HEADS = ['No', '商品', '合計（個）', 'いちばん早い受取'], PROD_SLOTS_HEAD = '受取の時刻ごとの個数（個）';
  /** 時刻の列の見出し: 「午前（時刻なし）」→〔「午前」,「（時刻なし）」〕の2行（xlsx と同じ）。括弧が無ければ1行 */
  function slotHeadParts(label) {
    var s = str(label), i = s.indexOf('（');
    return i > 0 ? [s.slice(0, i), s.slice(i)] : [s];
  }
  /** 商品の1行に書く字（画面・印刷で同じ）: 受注なし＝合計に「受注なし」・ほかは空／時刻の読めない分だけ＝早い受取に「時刻なし」／列は数のある所だけ */
  function prodRowTexts(it) {
    return { no: it.no ? String(it.no) : '', name: it.name || ('商品 ' + it.no), total: it.noOrders ? NONE_MARK : String(it.qty),
      early: it.noOrders ? '' : (it.earliest || '時刻なし'), earlyDim: !it.noOrders && !it.earliest,
      cells: it.cells.map(function (q) { return q > 0 ? String(q) : ''; }) };
  }
  /** 担当の組の見出し（xlsx と同じ言葉）: ■ 惣菜　申込書 6 件／■ 鮮魚　受注なし／■ 担当未設定　…（商品設定の「担当」が空の商品） */
  function prodGroupTitle(g) {
    return '■ ' + g.label + (g.noItems ? '' : '　' + (g.noOrders ? NONE_MARK : '申込書 ' + g.orderCount + ' 件')) + (g.unassigned ? '　（商品設定の「担当」が空の商品）' : '');
  }
  /**
   * 日の見出しの下の1行（xlsx と同じ言葉）: いつの時点か・その日の申込書の件数（受注の無い日は「この日の受注はありません」）。
   *   画面では、いつの時点かを表の上の数の札に出しているので省く（noAsOf）。紙には必ず書く
   */
  function prodDaySub(m, d, noAsOf) {
    return (noAsOf ? '' : (m.asOf ? m.asOf + ' 現在の受注（取消を除く）' : 'いまの受注（取消を除く）') + '　') +
      (d.noOrders ? 'この日の受注はありません' : 'この日の受け渡し: 申込書 ' + d.orderCount + ' 件') +
      (d.closedNewYear && !d.noOrders ? '　※元日営業でない設定の店です。受渡日を確かめてください' : '');
  }
  /**
   * 印刷の行の高さと時台の列の幅（mm）。A4 横（余白 8mm＝印刷できる 281×194mm）の1枚に、いちばん商品の多い日が収まるように。
   *   高さ: 194 − 題 9 − 時点 6 − 列の見出し 14 − 読み方 10 − 組の見出し 7×組 を、商品の行で割る（6〜11mm）。
   *   幅: 281 − No 9 − 合計 17 − 早い受取 20 − 時刻の無い列 18×数 − 商品名 50 を、時台の列で割る（7〜10mm）。CSS の col の幅と同じ値
   */
  function prodPrintLayout(m, days) {
    var maxRows = 1, maxGroups = 0;
    days.forEach(function (d) {
      var n = 0;
      d.groups.forEach(function (g) { n += Math.max(1, g.items.length); });
      maxRows = Math.max(maxRows, n);
      maxGroups = Math.max(maxGroups, d.groups.length);
    });
    var hours = m.slots.filter(function (s) { return s.kind === 'hour'; }).length, other = m.slots.length - hours;
    var rowMm = Math.max(6, Math.min(11, Math.floor((194 - 9 - 6 - 14 - 10 - 7 * maxGroups) / maxRows)));
    var hourMm = hours ? Math.max(7, Math.min(10, Math.floor((281 - 9 - 17 - 20 - 18 * other - 50) / hours))) : 10;
    return { rowMm: rowMm, hourMm: hourMm };
  }

  // ===== 受注状況の中身（openList の返事）を、画面で使う形に（DOM を使わない＝Node で試験できる） =====
  /**
   * 店渡し・宅配の1つ（openList の lists.store／lists.delivery）を掃除する。ページに切らない（全部の行）。
   *   壊れた応答で画面を重くしない: 全体で TOTAL_ROWS_MAX 行まで（budget を店渡しと宅配で分け合う）。同じ番号の行は1つだけ。
   *   返す: { blocks:[{no, title, method, lines, rows}], total, truncated }
   */
  function cleanList(src, budget) {
    src = objOf(src);
    var out = { blocks: [], total: toInt(src.totalRows) >= 0 ? toInt(src.totalRows) : 0, truncated: false };
    listOf(src.blocks, 100).forEach(function (b) {
      b = objOf(b);
      var no = toInt(b.no);
      if (!(no >= 1) || out.blocks.some(function (x) { return x.no === no; })) return;
      var cur = { no: no, title: cleanText(b.title, 120), method: cleanText(b.method, 20), lines: toInt(b.lines) >= 0 ? toInt(b.lines) : 0, rows: [] };
      var seen = {};
      var rows = Array.isArray(b.rows) ? b.rows : [];
      for (var i = 0; i < rows.length; i++) {
        if (budget.left <= 0) { out.truncated = true; break; }
        var c = cleanRow(rows[i]);
        if (!c.n || seen[c.n]) continue;
        seen[c.n] = 1;
        cur.rows.push(c);
        budget.left--;
      }
      cur.rows.sort(function (x, y) { return x.n - y.n; });
      out.blocks.push(cur);
    });
    out.blocks.sort(function (x, y) { return x.no - y.no; });
    if (!out.total) out.total = loadedRows(out.blocks);
    return out;
  }
  /**
   * openList の返事 → 画面のデータ。切り替え（店渡し・宅配・集計・店内受注品一覧）・印刷・「注文を直す」は、ここから描く（窓口へ取りに行かない）。
   *   { at（受け取った時刻）, asOf（窓口の時計）, store, orderCount, lists:{store, delivery}, truncated,
   *     summary:{summary, sandwich, deadline}|null, summaryError, production|null, productionError, orders:{OrderID: 注文の中身} }
   */
  function buildData(r, now) {
    r = objOf(r);
    var lists = objOf(r.lists), pe = objOf(r.partErrors), budget = { left: TOTAL_ROWS_MAX };
    var d = { at: now || Date.now(), asOf: cleanText(r.asOf, 20), store: cleanText(r.store, 40), orderCount: count0(r.orderCount), lists: {}, orders: {},
      summary: null, summaryError: '', production: null, productionError: '', truncated: false };
    ['store', 'delivery'].forEach(function (m) { d.lists[m] = cleanList(lists[m], budget); if (d.lists[m].truncated) d.truncated = true; });
    if (r.summary && typeof r.summary === 'object') d.summary = { summary: r.summary, sandwich: objOf(r.sandwich), deadline: r.deadline || null };
    else d.summaryError = cleanText(pe.summary, 200) || '集計を読み込めませんでした。';
    if (r.production && typeof r.production === 'object') d.production = cleanProduction(r.production);
    else d.productionError = cleanText(pe.production, 200) || '店内受注品一覧を読み込めませんでした。';
    var orders = objOf(r.orders), n = 0;
    Object.keys(orders).forEach(function (id) {
      if (n >= TOTAL_ROWS_MAX || !/^\d{8}-\d{6}$/.test(id) || !orders[id] || typeof orders[id] !== 'object') return;
      d.orders[id] = orders[id];
      n++;
    });
    return d;
  }
  /** 'yyyy/MM/dd HH:mm:ss' → 'HH:mm'（いつの内容かを短く） */
  function hhmm(s) { var m = str(s).match(/(\d{1,2}):(\d{2})/); return m ? (m[1].length < 2 ? '0' : '') + m[1] + ':' + m[2] : ''; }
  /**
   * 修正・取消のあと、その注文の行を手元で直す（裏の読み直しを待たずに、一覧を正しく見せる）。
   *   info: { mode:'update'|'cancel'|'gone', orderId, version, store, order（送った中身） }
   *   取消・見つからない・本部がほかの店へ移した → その注文の行を消す。修正 → 数量・お客様・受付係員・版を直す（数の無くなった商品の行は消し、
   *   増えた商品の行は最後に足す）。直した行には印（pending）を付ける（読み直しが届くと消える）。集計・店内受注品一覧は読み直しを待つ
   */
  function patchData(d, info) {
    var id = str(info && info.orderId);
    if (!d || !id) return;
    var drop = function (m, b) {
      var before = b.rows.length;
      b.rows = b.rows.filter(function (r) { return r.orderId !== id; });
      var gone = before - b.rows.length;
      b.lines = Math.max(0, b.lines - gone);
      d.lists[m].total = Math.max(0, d.lists[m].total - gone);
    };
    var moved = info.mode === 'update' && info.store && cleanText(info.store, 40) !== d.store;
    if (info.mode !== 'update' || moved) {
      ['store', 'delivery'].forEach(function (m) { d.lists[m].blocks.forEach(function (b) { drop(m, b); }); });
      if (d.orders[id]) { delete d.orders[id]; d.orderCount = Math.max(0, d.orderCount - 1); }
      return;
    }
    var o = objOf(info.order), prev = objOf(d.orders[id]);
    var version = toInt(info.version) >= 1 ? toInt(info.version) : (toInt(prev.version) >= 1 ? toInt(prev.version) + 1 : 1);
    var merged = Object.assign({}, prev, { store: d.store, pickupTime: o.pickupTime, receptionist: o.receptionist, receiver: o.receiver, requester: o.requester,
      items: Array.isArray(o.items) ? o.items : [], datedItems: Array.isArray(o.datedItems) ? o.datedItems : [], version: version });
    d.orders[id] = merged;
    var qtyOf = function (no, m) {
      var it = merged.items.filter(function (x) { return x && toInt(x.no) === no; })[0];
      var q = it ? toInt(m === 'store' ? it.storeQty : it.deliveryQty) : 0;
      return q > 0 ? q : 0;
    };
    ['store', 'delivery'].forEach(function (m) {
      d.lists[m].blocks.forEach(function (b) {
        var q = qtyOf(b.no, m), hit = -1;
        for (var i = 0; i < b.rows.length; i++) if (b.rows[i].orderId === id) { hit = i; break; }
        if (!q) { if (hit >= 0) drop(m, b); return; }
        var base = hit >= 0 ? b.rows[hit] : null;
        var row = cleanRow({ n: base ? base.n : (b.rows.length ? b.rows[b.rows.length - 1].n + 1 : 1), page: base ? base.page : 0,
          receivedAt: base ? base.receivedAt : str(prev.registeredAt).slice(0, 16), orderId: id, version: version, qty: q,
          receiver: m === 'delivery' ? merged.receiver : {}, requester: merged.requester, receptionist: merged.receptionist });
        row.pending = true;
        if (hit >= 0) b.rows[hit] = row;
        else { b.rows.push(row); b.lines++; d.lists[m].total++; }
      });
    });
  }

  // ===== 受注状況のページのメモリ（2026-10-31） =====
  //   同じ画面（ページ）で受注状況を開き直したとき・本部が同じ店を選び直したとき、前に読んだ一覧をすぐ出し（「読み込み直しています…」の印）、
  //   裏で読み直す。お客様の氏名・住所・電話を含む＝ページのメモリだけ（localStorage・sessionStorage・IndexedDB に入れない。店の端末は共有）。
  //   持つのは同じ人（メール）の、最後に開いた店から6店まで・読んでから30分まで。サインアウト・使えないアカウントで捨てる（osechi.js が forget を呼ぶ）
  var MEM_MAX = 6, MEM_TTL_MS = 30 * 60 * 1000;
  var MEM = { owner: '', list: [] };   // list: [{ store, data }]（新しい順）
  function memOwner() { return str(L && L.host && L.host.me && L.host.me.email).toLowerCase(); }
  function memGet(store, now) {
    var owner = memOwner();
    if (!owner || MEM.owner !== owner) { MEM.list = []; MEM.owner = owner; return null; }
    var t = now || Date.now();
    MEM.list = MEM.list.filter(function (e) { return t - e.data.at < MEM_TTL_MS; });
    var hit = MEM.list.filter(function (e) { return e.store === store; })[0];
    return hit ? hit.data : null;
  }
  function memPut(store, data) {
    var owner = memOwner();
    if (!owner || !store || !data) return;
    if (MEM.owner !== owner) { MEM.list = []; MEM.owner = owner; }
    MEM.list = [{ store: store, data: data }].concat(MEM.list.filter(function (e) { return e.store !== store; })).slice(0, MEM_MAX);
  }
  /** ページのメモリを捨てる（サインアウト・使えないアカウント。osechi.js から呼ぶ） */
  function forget() { MEM.list = []; MEM.owner = ''; }

  // ===== 画面 =====
  var L = null;   // 状態（個人情報を含む。dispose で捨てる。店ごとの最後の一覧は上のページのメモリ）
  function render(host) {
    dispose();
    injectStyle();
    var me = host.me || {};
    L = { host: host, h: host.h, seq: 1, store: me.role === 'hq' ? '' : str(me.store), tab: 'store', query: '', data: null, dl: false, els: {}, prodDay: '',
      refreshing: false, refreshError: '', wantGen: 0, patches: [], open: {} };
    buildFrame();
    L.wrapEl = host.wrap;
    L.wrapEl.classList.add('osechi-lwide');   // PC では横幅を使う（ほかの画面に戻すと外す）
    // 店内受注品一覧の表が横に入りきらない幅では、カードの形にする（窓の幅が変わったら測り直す）
    L.onResize = function () { if (L && L.resizeTimer) clearTimeout(L.resizeTimer); if (L) L.resizeTimer = setTimeout(function () { fitProdTable(); }, 120); };
    root.addEventListener('resize', L.onResize);
    if (L.store) openStore();
    else renderContent();
  }
  function dispose() {
    removePrint();
    if (L && L.onResize) { root.removeEventListener('resize', L.onResize); if (L.resizeTimer) clearTimeout(L.resizeTimer); }
    if (L && L.wrapEl) L.wrapEl.classList.remove('osechi-lwide');
    if (L && L.els.root && L.els.root.parentNode) L.els.root.parentNode.removeChild(L.els.root);
    L = null;
  }
  function alive(seq) { return !!(L && L.host.alive() && (seq === undefined || seq === L.seq)); }
  function isHq() { return !!(L && L.host.me && L.host.me.role === 'hq'); }
  function storeArg() { return isHq() ? { store: L.store } : {}; }

  function buildFrame() {
    var h = L.h, host = L.host, w = host.wrap;
    host.clear(w);
    host.setFooter(null);
    var E = L.els;
    E.storeRow = h('div', { 'class': 'osechi-card osechi-lstore', 'data-step': 'list-store' });
    if (isHq()) {
      var sel = h('select', { 'class': 'osechi-input', id: 'osechi-l-store', 'data-field': 'list-store', 'aria-label': 'どの店を見るか' });
      sel.appendChild(h('option', { value: '', text: '— 店を選んでください —' }));
      ((host.cfg && host.cfg.stores) || []).forEach(function (s) { sel.appendChild(h('option', { value: s, text: s })); });
      sel.addEventListener('change', function () { onStoreChange(sel.value); });
      E.storeSel = sel;
      E.storeCount = h('span', { 'class': 'osechi-small', 'data-step': 'list-store-count', 'aria-live': 'polite' });
      E.storeRow.appendChild(h('label', { 'class': 'osechi-label', 'for': 'osechi-l-store', text: 'どの店を見ますか（店渡し・宅配・集計・店内受注品一覧。毎回選びます）' }));
      E.storeRow.appendChild(sel);
      E.storeRow.appendChild(E.storeCount);
      // 全店の注文（本部だけ・PO 2026-10-31）: 店を選ぶ前でも押せる。店の区分にはボタンを作らない（窓口も断る）
      E.btnAll = h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-secondary', 'data-act': 'list-all-xlsx', text: '全店の注文（Excel）をダウンロード' });
      E.btnAll.addEventListener('click', function () { download('all'); });
      E.storeRow.appendChild(h('div', { 'class': 'osechi-lall', 'data-step': 'list-all' }, [E.btnAll,
        h('div', { 'class': 'osechi-small', text: '店を選ばなくても、全店の注文（取消を除く・1行が1件の注文）を1つの Excel にできます。' })]));
    } else {
      E.storeRow.appendChild(h('div', { 'class': 'osechi-fixed', 'data-field': 'list-store' }, [h('span', { text: '店: ' + L.store }), h('small', { text: '自店だけ（変更できません）' })]));
      E.storeCount = h('span', { 'class': 'osechi-small', 'data-step': 'list-store-count', 'aria-live': 'polite' });
      E.storeRow.appendChild(E.storeCount);
    }
    E.deadline = h('div', { 'data-step': 'deadline', 'aria-live': 'polite' });
    E.rules = h('details', { 'class': 'osechi-small osechi-lrules', 'data-step': 'list-rules' }, [   // 決まりは毎回は読まない＝畳む（一覧を上に）
      h('summary', { text: '報告のしかた（送り先・宅配・最終確認）' }), h('p', { text: REPORT_RULES })
    ]);
    E.note = h('div', { 'data-step': 'list-note', 'aria-live': 'polite' });
    E.tabs = h('div', { 'class': 'osechi-ltabs', role: 'tablist', 'aria-label': '受注状況の切り替え', 'data-step': 'list-tabs' });
    TABS.forEach(function (t) {
      var b = h('button', { type: 'button', role: 'tab', 'class': 'osechi-btn osechi-btn-secondary', 'data-tab': t[0], 'aria-selected': 'false', text: t[1] });
      b.addEventListener('click', function () { onTab(t[0]); });
      E.tabs.appendChild(b);
    });
    E.btnXlsx = h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-gold', 'data-act': 'list-xlsx', text: '報告用ファイル（Excel）をダウンロード' });
    E.btnXlsx.addEventListener('click', function () { download('xlsx'); });
    E.btnCsv = h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-secondary', 'data-act': 'list-csv', text: 'CSV をダウンロード' });
    E.btnCsv.addEventListener('click', function () { download('csv'); });
    E.btnPrint = h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-secondary', 'data-act': 'list-print', text: '印刷' });
    E.btnPrint.addEventListener('click', onPrint);
    E.actions = h('div', { 'class': 'osechi-lactions', 'data-step': 'list-actions' }, [E.btnXlsx, h('div', { 'class': 'osechi-btn-row' }, [E.btnCsv, E.btnPrint])]);
    // 店内受注品一覧の操作（同じ場所に入れ替えて出す＝いま見ている表の Excel と印刷だけ。お客様リストの報告用ファイルと混ぜない）
    //   表を最初の画面に入れるため、2つを1段に（補助の操作で上を占めない）
    E.btnProdXlsx = h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-gold', 'data-act': 'prod-xlsx', 'aria-label': '店内受注品一覧（Excel）をダウンロード', text: 'Excel をダウンロード' });
    E.btnProdXlsx.addEventListener('click', function () { download('production'); });
    E.btnProdPrint = h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-secondary', 'data-act': 'prod-print', 'aria-label': '店内受注品一覧を印刷（A4 横・1日1ページ）', text: '印刷（A4 横）' });
    E.btnProdPrint.addEventListener('click', onProdPrint);
    E.prodActions = h('div', { 'class': 'osechi-lactions osechi-prod-actions osechi-hidden', 'data-step': 'prod-actions' }, h('div', { 'class': 'osechi-btn-row' }, [E.btnProdXlsx, E.btnProdPrint]));
    E.search = h('input', { type: 'search', 'class': 'osechi-input', 'data-field': 'list-search', maxlength: String(SEARCH_MAX), placeholder: '氏名・電話・受付番号で探す', 'aria-label': 'お客様を探す（氏名・電話・受付番号）', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search' });
    E.search.addEventListener('input', function () { L.query = searchLimit(E.search.value); renderContent(); });   // 貼り付けなどで長くても100字で切る
    E.searchBox = h('div', { 'class': 'osechi-lsearch' }, [E.search]);
    // 読み直しの印（2026-10-31）: 一覧のすぐ上。読み直している間も一覧はそのまま使える（押せる・探せる・切り替えられる）
    E.fresh = h('div', { 'class': 'osechi-lfresh', 'data-step': 'list-fresh', role: 'status', 'aria-live': 'polite' });
    E.count = h('div', { 'class': 'osechi-small', 'data-step': 'list-count', 'aria-live': 'polite' });
    E.content = h('div', { 'data-step': 'list-body' });
    E.root = h('div', { 'class': 'osechi-list', 'data-step': 'list' }, [E.storeRow, E.deadline, E.rules, E.note, E.tabs, E.actions, E.prodActions, E.searchBox, E.fresh, E.count, E.content]);
    w.appendChild(E.root);
    refreshChrome();
  }
  /** 店・切り替え・ボタンの状態（店が決まるまで押せない・はじめの読み込みが終わるまで印刷とダウンロードは押せない。読み直しの間は押せる） */
  function refreshChrome() {
    var E = L.els, has = !!L.store, ready = !!L.data;
    Array.prototype.forEach.call(E.tabs.querySelectorAll('[data-tab]'), function (b) {
      var on = b.getAttribute('data-tab') === L.tab;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.classList.toggle('osechi-on', on);
      b.disabled = !has;
    });
    var prod = L.tab === 'production', pm = ready ? L.data.production : null;
    [E.btnXlsx, E.btnCsv, E.btnPrint].forEach(function (b) { b.disabled = !has || L.dl || !ready; });
    if (E.btnAll) E.btnAll.disabled = L.dl;   // 全店の注文は店を選ばなくても押せる
    E.btnProdXlsx.disabled = !has || L.dl || !ready;
    E.btnProdPrint.disabled = !has || L.dl || !pm || !pm.days.length;   // 印刷は画面の数をそのまま使う＝読めてから
    E.actions.classList.toggle('osechi-hidden', prod);
    E.prodActions.classList.toggle('osechi-hidden', !prod);
    // 締め日の帯・報告のしかた・申込書の枚数は、報告（お客様リスト）のためのもの＝店内受注品一覧では畳んで、表を最初の画面に入れる
    [E.deadline, E.rules, E.storeCount].forEach(function (el) { el.classList.toggle('osechi-hidden', prod); });
    E.searchBox.classList.toggle('osechi-hidden', !has || L.tab === 'summary' || prod);   // 店内受注品一覧は商品が1日に十数行・お客様の名前なし＝探す場面が無い
    E.storeCount.textContent = ready ? '申込書 ' + L.data.orderCount + ' 枚（取消を除く）' : '';
    renderFresh();
  }
  /** 読み直しの印: 読み直している間は動く印と「読み込み直しています…」（いつの内容かも）。失敗したら、いつの内容かと「もう一度」 */
  function renderFresh() {
    var E = L.els, h = L.h;
    L.host.clear(E.fresh);
    if (!L.data) return;
    var when = hhmm(L.data.asOf);
    if (L.refreshing) {
      E.fresh.appendChild(h('div', { 'class': 'osechi-lfresh-on', 'data-kind': 'refreshing' }, [h('span', { 'class': 'osechi-spin-s', 'aria-hidden': 'true' }),
        h('span', { text: '読み込み直しています…' + (when ? '（いまの表は ' + when + ' の内容・このまま使えます）' : '（このまま使えます）') })]));
    } else if (L.refreshError) {
      E.fresh.appendChild(h('div', { 'class': 'osechi-warn osechi-lfresh-ng', 'data-kind': 'stale' }, [
        h('span', { text: (when ? when + ' の内容です。' : '') + '最新にできませんでした（' + L.refreshError + '）' }),
        h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-secondary', 'data-act': 'list-refresh', text: 'もう一度読み込む', on: { click: function () { refresh(); } } })]));
    }
  }
  function onStoreChange(v) {
    if (!L || L.host.isBusy()) { if (L && L.els.storeSel) L.els.storeSel.value = L.store; return; }
    // 店を変えたら、前の店のお客様の情報は画面から消す（ページのメモリの一覧は、同じ店を選び直したときに先に出すため、30分まで残る）
    L.store = str(v);
    L.seq++;
    L.data = null;
    L.patches = [];
    L.refreshing = false; L.refreshError = ''; L.wantGen = 0;
    L.prodDay = '';
    L.query = '';
    L.open = {};
    L.els.search.value = '';
    setNote('');
    renderDeadline();
    refreshChrome();
    if (L.store) openStore(); else renderContent();
  }
  function onTab(t) {
    if (!L || !L.store || L.host.isBusy()) return;
    L.tab = t;   // 4つとも、受け取った中身から描く（窓口へ取りに行かない）
    refreshChrome();
    renderContent();
  }
  function setNote(text) {
    var E = L.els;
    L.host.clear(E.note);
    if (text) E.note.appendChild(L.h('div', { 'class': 'osechi-info', role: 'status', text: text }));
  }
  /** 店が決まったら: ページのメモリに前の一覧があれば、すぐ出して裏で読み直す。無ければ読み込む（先に枠を出して、あとから埋める） */
  function openStore() {
    var hit = memGet(L.store);
    if (hit) {
      L.data = hit;
      if (!L.data.production || !L.data.production.days.some(function (x) { return x.date === L.prodDay; })) L.prodDay = L.data.production ? defaultProdDay(L.data.production) : '';
      renderDeadline();
    }
    refreshChrome();
    renderContent();
    refresh();
  }
  /**
   * 受注状況を読み直す（openList の1本）。一覧があれば出したまま裏で読み、届いたら差し替える（場所・切り替え・探す語はそのまま）。
   * 読み直しの途中にもう一度頼まれたら、終わってから1回だけ読み直す（修正のあとの読み直しが、前の読み直しの古い中身で終わらないように）。
   * 読み直しを始めたあとに手元で直した行（修正・取消）は、届いた中身にもう一度当てる
   */
  function refresh() {
    if (!L || !L.store) return;
    L.wantGen++;
    if (L.refreshing) { renderFresh(); return; }
    runRefresh();
  }
  async function runRefresh() {
    var seq = L.seq, gen = L.wantGen, t0 = Date.now();
    L.refreshing = true; L.refreshError = '';
    refreshChrome();
    if (!L.data) renderContent();
    var ok = false;
    try {
      var r = await L.host.api('openList', storeArg());
      if (!alive(seq)) return;
      var d = buildData(r);
      L.patches = L.patches.filter(function (p) { return p.at > t0; });   // 読み直しを始める前に直した分は、届く中身に入っている
      L.patches.forEach(function (p) { patchData(d, p.info); });
      var first = !L.data;
      L.data = d;
      memPut(L.store, d);
      if (!d.production || !d.production.days.some(function (x) { return x.date === L.prodDay; })) L.prodDay = d.production ? defaultProdDay(d.production) : '';
      ok = true;
      renderDeadline();
      keepScroll(renderContent, first);
    } catch (e) {
      if (!alive(seq)) return;
      if (handleAuth(e)) return;
      L.refreshing = false;
      // 古い窓口（openList を知らない）＝画面だけ先に新しくなった。電波では直らないので、そう伝える
      L.refreshError = (e && e.code === 'BAD_REQUEST' && e.field === 'action') ? '窓口がまだ新しくなっていません。本部へお知らせください' : ((e && e.message) || '読み込めませんでした');
      if (!L.data) renderContent();
      else if (L.tab === 'production') keepScroll(renderContent, false);   // 「最新の数にする」の釦を戻す
    } finally {
      if (alive(seq)) {
        L.refreshing = false;
        refreshChrome();
        if (ok && L.wantGen > gen) runRefresh();   // 読み直しの途中に頼まれた分
      }
    }
  }
  /** 描き直しても、見ている場所を動かさない（はじめの読み込みのときは上から） */
  function keepScroll(fn, first) {
    var b = L.host.body, keep = b ? b.scrollTop : 0;
    fn();
    if (b && !first) b.scrollTop = keep;
  }
  /** ログインの確認ができない・使えないアカウント → osechi.js の案内（静かな再交換はしない）。扱ったら true */
  function handleAuth(e) {
    if (e && (e.code === 'AUTH_DENIED' || e.code === 'SUMARECO_LOGIN' || e.code === 'AUTH_REQUIRED')) { L.host.stop(e); return true; }
    return false;
  }

  // ---- 締め日の帯 ----
  function renderDeadline() {
    var E = L.els, h = L.h;
    L.host.clear(E.deadline);
    var v = (L.data && L.data.summary) ? deadlineView(L.data.summary.deadline) : null;
    if (!v) return;
    E.deadline.appendChild(h('div', { 'class': 'osechi-ldead' + (v.today ? ' osechi-ldead-today' : ''), 'data-kind': v.today ? 'report-day' : 'deadline' }, [
      h('div', { 'class': 'osechi-ldead-main', text: v.main }),
      v.sub ? h('div', { 'class': 'osechi-ldead-sub', text: v.sub }) : null
    ]));
  }

  // ---- 中身（店渡し・宅配・集計） ----
  function renderContent() {
    if (!L) return;
    var E = L.els, h = L.h, host = L.host;
    host.clear(E.content);
    E.count.textContent = '';
    if (!L.store) {
      E.content.appendChild(h('div', { 'class': 'osechi-info', 'data-step': 'list-choose-store', text: '店を選ぶと、その店の店渡し・宅配・集計・店内受注品一覧が出ます。' }));
      return;
    }
    if (!L.data) {
      if (L.refreshError && !L.refreshing) E.content.appendChild(errorBox(L.refreshError, function () { refresh(); }));
      else E.content.appendChild(h('div', { 'class': 'osechi-card osechi-lskeleton', 'data-step': 'list-loading', role: 'status' }, [h('span', { 'class': 'osechi-spin-s', 'aria-hidden': 'true' }), '受注状況を読み込んでいます…']));
      return;
    }
    if (L.tab === 'summary') return renderSummary();
    if (L.tab === 'production') return renderProduction();
    var d = L.data.lists[L.tab];
    var view = filterBlocks(d.blocks, L.query), loaded = loadedRows(d.blocks);
    var hits = view.reduce(function (s, x) { return s + x.rows.length; }, 0);
    E.count.textContent = searchText(L.query)
      ? '見つかった ' + hits + ' 行（' + loaded + ' 行の中から）'
      : METHOD_LABEL[L.tab] + ' ' + loaded + ' 行・行を押すと、その注文を直せます（取り消しも）';
    var searching = !!searchText(L.query);
    var full = view.filter(function (x) { return searching || x.block.lines > 0; });
    var empty = searching ? [] : view.filter(function (x) { return !x.block.lines; });
    if (!full.length) E.content.appendChild(h('div', { 'class': 'osechi-info', text: searching ? '当たる行がありません。' : 'まだ注文はありません。' }));
    full.forEach(function (x) { E.content.appendChild(blockView(x.block, x.rows, searching)); });
    if (empty.length) E.content.appendChild(emptyGroup(empty));
    if (d.truncated || L.data.truncated) E.content.appendChild(h('div', { 'class': 'osechi-warn', 'data-step': 'list-limit', text: '表示の上限（' + TOTAL_ROWS_MAX + ' 行）に達しました。すべての行は「報告用ファイル（Excel）」で見てください。' }));
  }
  function errorBox(msg, retry) {
    var h = L.h;
    return h('div', { 'class': 'osechi-error', role: 'alert' }, [h('div', { text: msg }),
      h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-secondary', 'data-act': 'list-retry', text: 'もう一度読み込む', on: { click: retry } })]);
  }
  /** 見出しを押して開く・閉じる（読み直しで描き直しても、開け閉めはそのまま） */
  function toggler(head, body, key, open) {
    head.addEventListener('click', function () {
      var nowOpen = head.getAttribute('aria-expanded') !== 'true';
      head.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
      body.classList.toggle('osechi-hidden', !nowOpen);
      if (L) L.open[key] = nowOpen;
    });
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    body.classList.toggle('osechi-hidden', !open);
  }
  function openOf(key, dflt) { return Object.prototype.hasOwnProperty.call(L.open, key) ? L.open[key] : dflt; }
  /** 注文のない商品は、1つの見出しにまとめて畳む（注文のある商品の行までの、送る量を減らす）。畳んだ見出しにも「受注なし」と番号を出す（空白に見せない） */
  function emptyGroup(empty) {
    var h = L.h;
    var body = h('div', { 'class': 'osechi-lbody' }, empty.map(function (x) { return blockView(x.block, x.rows, false); }));
    var head = h('button', { type: 'button', 'class': 'osechi-lhead', 'data-act': 'list-empty' }, [
      h('span', { 'class': 'osechi-lhead-title', text: '注文のない商品（' + empty.length + ' 品）' }),
      h('span', { 'class': 'osechi-lhead-meta' }, [h('span', { 'class': 'osechi-lnone', text: NONE_MARK }), ' ' + empty.map(function (x) { return x.block.no; }).join('・') + ' 番（見出しを押すと開く・閉じる）'])
    ]);
    toggler(head, body, L.tab + ':empty', openOf(L.tab + ':empty', false));
    return h('section', { 'class': 'osechi-lblock osechi-lempty', 'data-step': 'list-empty' }, [head, body]);
  }
  /** 商品ごとのブロック（見出しを押すと開閉。空の商品は畳んでおく） */
  function blockView(b, rows, searching) {
    var h = L.h, method = L.tab;
    var dates = (L.host.idx && L.host.idx.byNo[b.no] && L.host.idx.byNo[b.no].dates.join('・')) || '12/31';
    var head = h('button', { type: 'button', 'class': 'osechi-lhead', 'data-act': 'list-block' }, [
      h('span', { 'class': 'osechi-lhead-title', text: b.title || ('商品 ' + b.no) }),
      b.lines ? h('span', { 'class': 'osechi-lhead-meta', text: (method === 'store' ? 'お渡し日 ' : '宅配日 ') + dates + '・' + b.lines + ' 件' })
        : h('span', { 'class': 'osechi-lhead-meta' }, [(method === 'store' ? 'お渡し日 ' : '宅配日 ') + dates + '・', h('span', { 'class': 'osechi-lnone', text: NONE_MARK })])
    ]);
    var body = h('div', { 'class': 'osechi-lbody' });
    if (!b.lines) body.appendChild(h('div', { 'class': 'osechi-small', 'data-kind': 'none' }, [h('span', { 'class': 'osechi-lnone', text: NONE_MARK }), ' まだ注文はありません。']));
    else body.appendChild(tableView(b, rows));
    toggler(head, body, method + ':' + b.no, searching || openOf(method + ':' + b.no, b.lines > 0));
    return h('section', { 'class': 'osechi-lblock' + (b.lines ? '' : ' osechi-lblock-empty'), 'data-no': String(b.no), 'data-method': method }, [head, body]);
  }
  var PARTY_COLS = [['zip', '郵便番号'], ['tel', '電話番号'], ['address', '住所'], ['name', '氏名']];
  var NOWRAP = { zip: 'osechi-lnw', tel: 'osechi-lnw' };   // 郵便番号・電話は途中で折り返さない（PC の表）
  /**
   * 行の表（PC は表・スマホは CSS で1行をカードに）。店渡しはご依頼主だけ。数量の列は画面にだけ（2以上を強調）。
   *   受付係員（追補 v6）は数量のすぐ右（受付・数量と同じ「受けたときのこと」の並び。番号・受付・数量の位置は前の版と同じ）。
   *   空は「記載なし」（窓口と同じ言葉・薄くしすぎない灰）。印刷（ひな形の15行）には入れない＝ひな形に欄が無い・住所の幅が足りなくなる
   *   直したばかりの行（読み直しの前）は「直しました（反映を待っています）」の印
   */
  function tableView(b, rows) {
    var h = L.h, method = L.tab, delivery = method === 'delivery';
    var heads = [h('th', { scope: 'col', text: '番号' }), h('th', { scope: 'col', text: '受付' }), h('th', { scope: 'col', text: '数量' }), h('th', { scope: 'col', text: '受付係員' })];
    if (delivery) PARTY_COLS.forEach(function (c) { heads.push(h('th', { scope: 'col', text: 'お届け先 ' + c[1] })); });
    PARTY_COLS.forEach(function (c) { heads.push(h('th', { scope: 'col', text: 'ご依頼主 ' + c[1] })); });
    var ncol = heads.length;
    var body = [], prevPage = rows.length ? rows[0].page : 0;
    rows.forEach(function (r, i) {
      if (i > 0 && r.page !== prevPage && r.page > 0) {
        body.push(h('tr', { 'class': 'osechi-lcont' }, h('td', { colspan: String(ncol), text: '（続き）' + (b.title || '') })));
      }
      prevPage = r.page;
      var cells = [
        h('td', { 'class': 'osechi-ln', 'data-label': '番号', text: String(r.n) }),
        h('td', { 'class': 'osechi-lrecv', 'data-label': '受付' }, [r.receivedAt + (r.orderId ? '　' + r.orderId : ''),
          r.pending ? h('span', { 'class': 'osechi-lpend', 'data-kind': 'pending', text: '直しました（反映を待っています）' }) : null]),
        h('td', { 'class': 'osechi-lqty' + (r.qty >= 2 ? ' osechi-lqty2' : ''), 'data-label': '数量', text: r.qty + ' 個' }),
        h('td', { 'class': 'osechi-lrcp' + (r.receptionist === RECEPTIONIST_NONE ? ' osechi-lrcp-none' : ''), 'data-label': '受付係員', 'data-kind': 'receptionist', text: r.receptionist })
      ];
      if (delivery) PARTY_COLS.forEach(function (c) { cells.push(h('td', { 'class': NOWRAP[c[0]] || null, 'data-label': 'お届け先 ' + c[1], text: r.receiver[c[0]] })); });
      PARTY_COLS.forEach(function (c) { cells.push(h('td', { 'class': NOWRAP[c[0]] || null, 'data-label': 'ご依頼主 ' + c[1], text: r.requester[c[0]] })); });
      var tr = h('tr', { 'class': 'osechi-lrow' + (r.pending ? ' osechi-lrow-pending' : ''), tabindex: '0', role: 'button', 'data-order': r.orderId, 'aria-label': '受付番号 ' + r.orderId + ' の注文を直す' }, cells);
      var go = function () { onRowEdit(r.orderId); };
      tr.addEventListener('click', go);
      tr.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
      body.push(tr);
    });
    return h('div', { 'class': 'osechi-lscroll' }, h('table', { 'class': 'osechi-ltable' + (delivery ? ' osechi-ltable-d' : '') }, [
      h('thead', null, h('tr', null, heads)), h('tbody', null, body)
    ]));
  }
  /**
   * 行を押した → 一覧と一緒に受け取った注文の中身から、すぐ「注文を直す」を開く（窓口へ取りに行かない・送るときに版で守る）。
   * 送ったら（修正・取消）: 一覧は消さずに、その行を手元で直し、裏で読み直す（「読み込み直しています…」）。読み直しの間も一覧は使える
   */
  function onRowEdit(orderId) {
    if (!orderId || !L || L.host.isBusy()) return;
    var seq = L.seq;
    L.host.editOrder(orderId, {
      order: L.data && L.data.orders[orderId],
      onDone: function (changed, text, info) {
        if (!alive(seq)) return;
        if (text) setNote(text);
        if (!changed) return;
        if (L.data && info) {
          L.patches.push({ at: Date.now(), info: info });
          patchData(L.data, info);
          memPut(L.store, L.data);
          renderDeadline();
          keepScroll(renderContent, false);
        }
        refresh();
      }
    });
  }

  // ---- 集計（おせち集計・サンド） ----
  function renderSummary() {
    var E = L.els, h = L.h, d = L.data;
    if (!d.summary) {   // 窓口が集計だけ作れなかった（ほかの切り替えは使える）
      E.content.appendChild(errorBox(d.summaryError || '集計を読み込めませんでした。', function () { refresh(); }));
      return;
    }
    var s = d.summary.summary || {};
    var late = s.late && toInt(s.late.count) > 0 ? toInt(s.late.count) : 0;
    // 表はひな形と同じく 0 を空欄にする＝空欄の意味を、表のすぐ上に書く（空欄＝受注なし・今日より先の行も空欄）
    E.count.textContent = '累計（その締め日までの合計）・空欄＝受注なし（今日より先の行も空欄）・途中経過＝次の締め日の分のいまの注文まで' + (s.asOf ? '・' + str(s.asOf) + ' 時点' : '');
    if (late) E.content.appendChild(h('div', { 'class': 'osechi-warn', text: '締め後の受付 ' + late + ' 件（最後の締め日の行に含めています）。' }));
    ['store', 'delivery'].forEach(function (m) {
      E.content.appendChild(h('h4', { 'class': 'osechi-lsub', text: METHOD_LABEL[m] + '（累計）' }));
      E.content.appendChild(summaryView(summaryTable(s, L.store, m), m));
    });
    var sw = sandwichRows(d.summary.sandwich);
    E.content.appendChild(h('h4', { 'class': 'osechi-lsub', text: 'パーティーサンドプレート（27番）・日付ごと' }));
    var rows = sw.rows.map(function (r) { return h('tr', null, [h('th', { scope: 'row', text: r.date }), r.qty === '' ? h('td', { 'class': 'osechi-snone', text: NONE_MARK }) : h('td', { text: String(r.qty) })]); });
    rows.push(h('tr', { 'class': 'osechi-stotal' }, [h('th', { scope: 'row', text: '期間の合計' }), h('td', { text: String(sw.total) })]));
    E.content.appendChild(h('div', { 'class': 'osechi-lscroll' }, h('table', { 'class': 'osechi-stable osechi-stable-sand', 'data-step': 'sandwich' }, [
      h('thead', null, h('tr', null, [h('th', { scope: 'col', text: '受渡日' }), h('th', { scope: 'col', text: sw.label || L.store })])), h('tbody', null, rows)
    ])));
    if (sw.notOpenNewYear) E.content.appendChild(h('div', { 'class': 'osechi-warn', text: '元日営業でない店の 1/1 の分が ' + sw.notOpenNewYear + ' 件あります（表には入れていません。注文を確かめてください）。' }));
    var warns = Array.isArray(s.warnings) ? s.warnings.slice(0, 10) : [];
    if (warns.length) E.content.appendChild(h('div', { 'class': 'osechi-warn' }, [h('b', { text: '集計で気づいたこと' })].concat(warns.map(function (w) {
      return h('div', { text: '・' + str(w && w.message).slice(0, 160) + (w && toInt(w.count) > 1 ? '（' + toInt(w.count) + ' 件）' : '') });
    }))));
  }
  function summaryView(t, method) {
    var h = L.h;
    var head = [h('th', { scope: 'col', 'class': 'osechi-sfix', text: '締め日' }), h('th', { scope: 'col', text: '報告日' })]
      .concat(t.items.map(function (it) { return h('th', { scope: 'col', title: it.label + (it.sub ? '　' + it.sub : ''), text: String(it.no) }); }))
      .concat([h('th', { scope: 'col', text: '合計' })]);
    var body = t.rows.map(function (r) {
      return h('tr', { 'class': (r.inProgress ? 'osechi-snow' : '') + (r.filled ? ' osechi-sfilled' : '') }, [
        h('th', { scope: 'row', 'class': 'osechi-sfix', text: mdDow(r.closing) + (r.inProgress ? ' 集計中' : '') }), h('td', { text: mdDow(r.report) })
      ].concat(r.cells.map(function (v) { return h('td', { text: v === '' ? '' : String(v) }); })).concat([h('td', { 'class': 'osechi-stot', text: r.total === '' ? '' : String(r.total) })]));
    });
    if (t.totalRow) body.push(h('tr', { 'class': 'osechi-stotal' }, [h('th', { scope: 'row', 'class': 'osechi-sfix', text: '合計（最新の累計）' }), h('td', { text: '' })]
      .concat(t.totalRow.cells.map(function (v) { return h('td', { text: v === '' ? '' : String(v) }); })).concat([h('td', { 'class': 'osechi-stot', text: String(t.totalRow.total || '') })])));
    if (t.pendingRow) body.push(h('tr', { 'class': 'osechi-spending', 'data-kind': 'pending' }, [h('th', { scope: 'row', 'class': 'osechi-sfix', text: '途中経過 ' + mdDow(t.pendingRow.closing) + '〆', title: '次の締め日の分（いまの注文まで）' }), h('td', { text: '' })]
      .concat(t.pendingRow.cells.map(function (v) { return h('td', { text: v === '' ? '' : String(v) }); })).concat([h('td', { 'class': 'osechi-stot', text: String(t.pendingRow.total || '') })])));
    return h('div', { 'class': 'osechi-lscroll osechi-sscroll' }, h('table', { 'class': 'osechi-stable', 'data-step': 'summary-' + method }, [h('thead', null, h('tr', null, head)), h('tbody', null, body)]));
  }

  // ---- 店内受注品一覧（惣菜・鮮魚の担当主任が「何を・いくつ・何時までに」作るかを見る表） ----
  //   上から: いつの時点か（数の札）→ 気づいたこと（候補の外・注意）→ 日の切り替え（日ごとの申込書の件数・受注なし）→ 選んだ日の表。
  //   表は xlsx と同じ並び（日 → 担当の組 → 商品・列は slots の順）。横に入りきらない幅ではカードにする（fitProdTable）
  function renderProduction() {
    var E = L.els, h = L.h, m = L.data.production;
    if (!m) {   // 窓口が店内受注品一覧だけ作れなかった（ほかの切り替えは使える）
      E.content.appendChild(errorBox(L.data.productionError || '店内受注品一覧を読み込めませんでした。', function () { refresh(); }));
      return;
    }
    E.count.textContent = (m.asOf ? m.asOf + ' 現在の受注（取消を除く）' : 'いまの受注（取消を除く）') + '・お渡し日の商品の申込書 ' + m.orderCount + ' 件';
    // 「最新の数にする」＝受注状況の全部を読み直す（読み直しの間も、いまの表を出したまま・一覧の上に「読み込み直しています…」）
    var reload = h('button', { type: 'button', 'class': 'osechi-btn osechi-btn-secondary osechi-prod-reload', 'data-act': 'prod-reload', text: L.refreshing ? '読み込んでいます…' : '最新の数にする' });
    reload.disabled = L.refreshing || L.dl;
    reload.addEventListener('click', function () { if (!L.host.isBusy() && !L.dl) { refresh(); renderContent(); } });
    E.content.appendChild(h('div', { 'class': 'osechi-prod-intro', 'data-step': 'prod-intro' }, [
      h('p', { 'class': 'osechi-small', text: '惣菜・鮮魚・サービスカウンターの担当が「何を・いくつ・何時までに」作るかの表です（お客様の名前は出ません）。' }),
      reload
    ]));
    if (m.warnings.length || m.outOfCandidates.length) {
      // 短く: 候補の外の数量は1行ずつ（作る数に入っていない＝見落とすと作り漏れ）。同じことを言う注意（OUT_OF_CANDIDATES）は、その見出しにまとめる
      var lines = [h('b', { text: '気づいたこと' })];
      if (m.outOfCandidates.length) {
        lines.push(h('div', { text: '・受渡日が商品設定の候補にない数量（下の表に入れていません。受渡日か商品設定を確かめてください）:' }));
        m.outOfCandidates.forEach(function (e) { lines.push(h('div', { 'class': 'osechi-prod-out', text: '　' + outLine(e) })); });
      }
      m.warnings.forEach(function (w) {
        if (w.code === 'OUT_OF_CANDIDATES' && m.outOfCandidates.length) return;
        lines.push(h('div', { text: '・' + w.message + (w.count > 1 ? '（' + w.count + ' 件）' : '') }));
      });
      E.content.appendChild(h('div', { 'class': 'osechi-warn osechi-prod-warn', 'data-step': 'prod-warn' }, lines));
    }
    if (!m.days.length) {
      E.content.appendChild(h('div', { 'class': 'osechi-info', 'data-step': 'prod-noitems', text: '商品設定に、お渡し日の商品がありません。' }));
      return;
    }
    var cur = prodSelected(m);
    E.content.appendChild(h('div', { 'class': 'osechi-prod-dhead', text: '受け渡しの日（押すと、その日の表に切り替わります）' }));
    var chips = h('div', { 'class': 'osechi-prod-days', role: 'tablist', 'aria-label': '受け渡しの日', 'data-step': 'prod-days' }, m.days.map(function (day) {
      var on = day === cur, ny = day.closedNewYear && !day.noOrders;
      var b = h('button', { type: 'button', role: 'tab', 'class': 'osechi-prod-day' + (on ? ' osechi-on' : '') + (day.noOrders ? ' osechi-prod-daynil' : '') + (ny ? ' osechi-prod-dayny' : ''),
        'aria-selected': on ? 'true' : 'false', 'data-act': 'prod-day', 'data-kind': day.date, title: ny ? '元日営業でない設定の店です。受渡日を確かめてください' : null }, [
        h('span', { 'class': 'osechi-prod-dlab', text: (ny ? '！' : '') + day.label }),
        h('span', { 'class': 'osechi-prod-dsub', text: day.noOrders ? NONE_MARK : '申込書 ' + day.orderCount + ' 件' })
      ]);
      b.addEventListener('click', function () { onProdDay(day.date); });
      return b;
    }));
    E.content.appendChild(chips);
    var tbox = h('div', { 'class': 'osechi-prod-tbox' + ((root.innerWidth || 1024) <= 760 ? ' osechi-prod-cards' : '') },
      h('table', { 'class': 'osechi-prod-table', 'data-step': 'prod-table', 'aria-label': '店内受注品一覧 ' + cur.label }, [h('thead', null, prodHeads(m, 'osechi-prod-')), h('tbody', null, prodBodyRows(m, cur, 'osechi-prod-'))]));
    E.content.appendChild(h('section', { 'class': 'osechi-prod-sec', 'data-step': 'prod-day', 'data-kind': cur.date }, [
      h('div', { 'class': 'osechi-prod-title' }, [h('h3', { text: cur.label }), h('span', { 'class': 'osechi-prod-store', text: m.storeLabel || L.store })]),
      h('div', { 'class': 'osechi-prod-sub' + (cur.closedNewYear && !cur.noOrders ? ' osechi-prod-subwarn' : ''), 'data-step': 'prod-sub', text: prodDaySub(m, cur, true) }),
      tbox,
      m.timeNote ? h('p', { 'class': 'osechi-small osechi-prod-note', text: m.timeNote }) : null
    ]));
    L.els.prodBox = tbox;
    fitProdTable();
  }
  function onProdDay(date) {
    if (!L || L.prodDay === date) return;
    L.prodDay = date;
    renderContent();
    var b = L.els.content.querySelector('[data-act="prod-day"][aria-selected="true"]');
    if (b && b.focus) { try { b.focus({ preventScroll: true }); } catch (e) { /* 何もしない */ } }
  }
  /** 表が横に入りきらなければカードの形にする（狭い画面は、はじめからカード）。窓の幅が変わったら測り直す */
  function fitProdTable() {
    var box = L && L.els.prodBox;
    if (!box || !box.isConnected) return;
    var narrow = (root.innerWidth || 1024) <= 760;
    box.classList.toggle('osechi-prod-cards', narrow);
    if (!narrow && box.firstChild && box.firstChild.scrollWidth > box.clientWidth + 1) box.classList.add('osechi-prod-cards');
  }

  // ---- ダウンロード（xlsx・CSV）: 1回押したら終わるまで押せない・自動で送り直さない ----
  var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  var DOWNLOADS = {
    xlsx: { action: 'exportReport', args: {}, busy: '報告用ファイル（Excel）を作っています…', ext: '.xlsx', mime: XLSX_MIME, fallback: 'おせち報告書_' },
    csv: { action: 'exportCsv', args: { kind: 'orders' }, busy: 'CSV を作っています…', ext: '.csv', mime: 'text/csv', fallback: 'おせちお客様リスト_' },
    production: { action: 'exportProduction', args: {}, busy: '店内受注品一覧（Excel）を作っています…', ext: '.xlsx', mime: XLSX_MIME, fallback: '店内受注品一覧_' },
    // 全店の注文（本部だけ・PO 2026-10-31）: 店を選ばなくても押せる（店を送らない）。窓口も本部かを確かめる
    all: { action: 'exportAllOrders', args: {}, busy: '全店の注文（Excel）を作っています…', ext: '.xlsx', mime: XLSX_MIME, fallback: 'おせち注文_全店_', allStores: true }
  };
  async function download(kind) {
    var D = own(DOWNLOADS, kind) ? DOWNLOADS[kind] : null;
    if (!L || !D || L.dl || L.host.isBusy() || (D.allStores ? !isHq() : !L.store)) return;
    var seq = L.seq, host = L.host;
    L.dl = true;
    refreshChrome();
    var layer = host.busy(D.busy, { sub: '回数に上限があるので、終わるまでお待ちください' });
    try {
      var r = await host.api(D.action, Object.assign({}, D.args, D.allStores ? {} : storeArg()));
      host.endBusy(layer);
      if (!alive(seq)) return;
      var bytes = base64ToBytes(r.base64);
      if (D.ext === '.xlsx' && !isZipBytes(bytes)) throw new Error('受け取ったファイルが Excel の形ではありません');
      var name = /\.(xlsx|csv)$/i.test(str(r.filename)) ? str(r.filename) : D.fallback + (D.allStores ? '' : L.store) + D.ext;
      var saved = host.saveFile(bytes, D.mime, name, D.ext);
      setNote('ダウンロードしました: ' + saved + (r.reportDate ? '（報告日 ' + str(r.reportDate) + '）' : ''));
    } catch (e) {
      host.endBusy(layer);
      if (!alive(seq)) return;
      if (handleAuth(e)) return;
      await host.alert((e && e.message) || 'ダウンロードできませんでした。', '', 'ダウンロードできませんでした');
    } finally {
      if (L && L.seq === seq) { L.dl = false; refreshChrome(); }
    }
  }

  // ---- 印刷（A4 横・商品ごとに改ページ・ひな形に近い見た目）。印刷のたびに記録・印刷用の領域は終わったら消す ----
  async function onPrint() {
    if (!L || !L.store || !L.data || L.host.isBusy() || L.dl) return;
    var host = L.host, seq = L.seq;
    var method = L.tab === 'delivery' ? 'delivery' : 'store';
    if (L.tab === 'summary') {
      var pick = await host.ask({ tone: 'info', title: '印刷', message: 'どちらのお客様リストを印刷しますか？',
        buttons: [{ id: 'store', label: '店渡しのお客様リスト', kind: 'primary' }, { id: 'delivery', label: '宅配のお客様リスト', kind: 'secondary' }, { id: 'cancel', label: 'やめる', kind: 'secondary' }], cancelId: 'cancel' });
      if (pick !== 'store' && pick !== 'delivery') return;
      method = pick;
    }
    if (!alive(seq) || !L.data) return;
    // 全部の行は、受注状況を開いたときに受け取っている（openList）＝窓口へ取りに行かない。画面の行（直したばかりの行も）をそのまま印刷する
    var d = L.data.lists[method];
    var pages = printPages(d.blocks);
    if (!pages.length) { await host.alert(METHOD_LABEL[method] + 'のお客様リストに、まだ行がありません。', '', '印刷する行がありません'); return; }
    var ok = await host.confirm(METHOD_LABEL[method] + 'のお客様リスト（' + loadedRows(d.blocks) + ' 行・' + pages.length + ' ページ・A4 横）を印刷します。\n印刷が終わると、印刷用の画面は消えます。',
      { yes: '印刷する', no: 'やめる', title: '印刷の確認' });
    if (!ok || !alive(seq)) return;
    var lay2 = host.busy('印刷の準備をしています…');
    try {
      await host.api('logPrint', Object.assign({ method: method }, storeArg()));
    } catch (e) {
      host.endBusy(lay2);
      if (!alive(seq)) return;
      if (handleAuth(e)) return;
      await host.alert(e.message, '', '印刷できませんでした');
      return;
    }
    host.endBusy(lay2);
    if (!alive(seq)) return;
    buildPrint(pages, method);
    startPrint();
  }
  /** 印刷の画面を出す。終わったら（afterprint）印刷用の領域を消す。合図が来ない端末でも、2分で消す */
  function startPrint() {
    var done = function () { removePrint(); root.removeEventListener('afterprint', done); };
    root.addEventListener('afterprint', done);
    L.printTimer = setTimeout(done, 120000);
    try { root.print(); } catch (e2) { done(); }
  }

  // ---- 店内受注品一覧の印刷（A4 横・1日＝1ページ・xlsx と同じ並び）。画面の数をそのまま印刷する（いつの時点かを紙にも出す） ----
  async function onProdPrint() {
    if (!L || !L.store || L.host.isBusy() || L.dl) return;
    var m = L.data && L.data.production;
    if (!m || !m.days.length) return;
    var host = L.host, seq = L.seq, cur = prodSelected(m);
    var msg = '店内受注品一覧を印刷します（A4 横・1日＝1ページ・' + (m.asOf ? m.asOf + ' 現在の数' : 'いまの数') + '）。\n印刷が終わると、印刷用の画面は消えます。';
    var pick;
    if (m.days.length === 1) pick = (await host.confirm(msg, { yes: '印刷する', no: 'やめる', title: '印刷の確認' })) ? 'all' : '';
    else {
      pick = await host.ask({ tone: 'info', title: '印刷の確認', message: msg, cancelId: 'cancel', buttons: [
        { id: 'day', label: cur.label + ' だけ（1 ページ）', kind: 'primary' },
        { id: 'all', label: '全部の日（' + m.days.length + ' ページ' + (m.outOfCandidates.length ? '＋候補の外 1 ページ' : '') + '）', kind: 'secondary' },
        { id: 'cancel', label: 'やめる', kind: 'secondary' }] });
    }
    if ((pick !== 'day' && pick !== 'all') || !alive(seq)) return;
    var t0 = Date.now();
    var lay = host.busy('印刷の準備をしています…');
    try {
      await host.api('logPrint', Object.assign({ method: 'production' }, storeArg()));
    } catch (e) {
      host.endBusy(lay);
      if (!alive(seq)) return;
      if (handleAuth(e)) return;
      await host.alert(e.message, '', '印刷できませんでした');
      return;
    }
    host.endBusy(lay);
    if (!alive(seq)) return;
    buildProdPrint(m, pick === 'day' ? [cur] : m.days, pick === 'all');
    L.prodPrintMs = Date.now() - t0;   // 印刷の用意（記録＋領域づくり）の時間（試験で測る）
    startPrint();
  }
  function prodSelected(m) { return m.days.filter(function (x) { return x.date === L.prodDay; })[0] || m.days[0]; }
  function groupClass(g) { return g.unassigned ? 'osechi-prod-gn' : (own(DEPT_CLASS, g.dept) ? DEPT_CLASS[g.dept] : 'osechi-prod-go'); }
  /** 列の見出し2行（No・商品・合計（個）・いちばん早い受取・受取の時刻ごとの個数（個）→ 列ごとの名前）。印刷と画面で同じ */
  function prodHeads(m, cls) {
    var h = L.h, two = m.slots.length ? '2' : '1', keys = ['hno', 'hname', 'hqty', 'hearly'];
    var r1 = PROD_HEADS.map(function (t, i) { return h('th', { scope: 'col', rowspan: two, 'class': cls + keys[i], text: t }); });
    if (!m.slots.length) return [h('tr', { 'class': cls + 'hrow' }, r1)];
    r1.push(h('th', { scope: 'colgroup', colspan: String(m.slots.length), 'class': cls + 'hslots', text: PROD_SLOTS_HEAD }));
    var r2 = m.slots.map(function (s) {
      var p = slotHeadParts(s.label);
      return h('th', { scope: 'col', 'class': cls + 'hs' + (s.kind === 'hour' ? '' : ' ' + cls + 'hsx'), title: s.label }, p.length > 1 ? [p[0], h('br'), p[1]] : p);
    });
    return [h('tr', { 'class': cls + 'hrow' }, r1), h('tr', { 'class': cls + 'hrow ' + cls + 'hrow2' }, r2)];
  }
  /** 担当の組ごとの行（組の見出し → 商品の行。商品の無い組は「この日に受け渡す商品はありません」）。印刷と画面で同じ中身 */
  function prodBodyRows(m, day, cls) {
    var h = L.h, ncol = String(4 + m.slots.length), rows = [];
    day.groups.forEach(function (g) {
      rows.push(h('tr', { 'class': cls + 'grp ' + groupClass(g), 'data-kind': g.unassigned ? 'unassigned' : 'dept' }, h('th', { scope: 'colgroup', colspan: ncol, text: prodGroupTitle(g) })));
      if (g.noItems) { rows.push(h('tr', { 'class': cls + 'empty' }, h('td', { colspan: ncol, text: 'この日に受け渡す商品はありません' }))); return; }
      g.items.forEach(function (it) {
        var t = prodRowTexts(it);
        var cells = [
          h('td', { 'class': cls + 'no', text: t.no }),
          h('th', { scope: 'row', 'class': cls + 'name' }, h('div', { 'class': cls + 'nm', text: t.name })),
          h('td', { 'class': cls + 'qty ' + (it.noOrders ? cls + 'nil' : cls + 'has'), 'data-label': '合計', text: t.total }),
          h('td', { 'class': cls + 'early' + (it.noOrders ? ' ' + cls + 'zero' : (t.earlyDim ? ' ' + cls + 'dim' : '')), 'data-label': PROD_HEADS[3], text: t.early })
        ];
        m.slots.forEach(function (s, k) {
          cells.push(h('td', { 'class': cls + 'slot' + (t.cells[k] ? '' : ' ' + cls + 'zero'), 'data-label': s.label, text: t.cells[k] }));
        });
        rows.push(h('tr', { 'class': cls + 'row' + (it.noOrders ? ' ' + cls + 'rownil' : ''), 'data-no': String(it.no) }, cells));
      });
    });
    return rows;
  }
  /**
   * 印刷用の領域（店内受注品一覧）。1日＝1ページ（日ごとに改ページ・入らない日は続きのページへ＝見出しは各ページに出る）。
   *   題・店・いつの時点か・列の見出しは thead に入れる。全部の日を印刷するときは、候補の外の数量を最後のページに（xlsx と同じ）
   */
  function buildProdPrint(m, days, withOut) {
    removePrint();
    var h = L.h, doc = root.document, lay = prodPrintLayout(m, days), P = 'osechi-prodp-', ncol = String(4 + m.slots.length);
    var region = h('div', { id: PRINT_ID, 'class': 'osechi-print osechi-prodp osechi-prodp-r' + lay.rowMm + ' osechi-prodp-w' + lay.hourMm, 'aria-hidden': 'true', 'data-kind': 'production' });
    var cols = function () {
      return [h('col', { 'class': P + 'cno' }), h('col', { 'class': P + 'cname' }), h('col', { 'class': P + 'cqty' }), h('col', { 'class': P + 'cearly' })]
        .concat(m.slots.map(function (s) { return h('col', { 'class': s.kind === 'hour' ? P + 'ch' : P + 'cx' }); }));
    };
    var pages = days.length + (withOut && m.outOfCandidates.length ? 1 : 0);
    days.forEach(function (day, di) {
      var top = h('tr', { 'class': P + 'trow' }, h('th', { colspan: ncol, scope: 'colgroup' }, h('div', { 'class': P + 'thead' }, [
        h('span', { 'class': P + 'title', text: '店内受注品一覧　' + day.label }),
        h('span', { 'class': P + 'store', text: (m.storeLabel || L.store) + '　' + (di + 1) + ' / ' + pages })
      ])));
      var sub = h('tr', { 'class': P + 'srow' }, h('th', { colspan: ncol, scope: 'colgroup', 'class': day.closedNewYear && !day.noOrders ? P + 'subwarn' : null, text: prodDaySub(m, day) }));
      region.appendChild(h('section', { 'class': P + 'page', 'data-kind': day.date }, [
        h('table', { 'class': P + 'table' }, [h('colgroup', null, cols()), h('thead', null, [top, sub].concat(prodHeads(m, P))), h('tbody', null, prodBodyRows(m, day, P))]),
        m.timeNote ? h('div', { 'class': P + 'note', text: m.timeNote }) : null
      ]));
    });
    if (withOut && m.outOfCandidates.length) {
      region.appendChild(h('section', { 'class': P + 'page ' + P + 'out', 'data-kind': 'out' }, [
        h('div', { 'class': P + 'title', text: '店内受注品一覧　受渡日が商品設定の候補にない数量' }),
        h('div', { 'class': P + 'outhead', text: '※上の表に入れていません。受渡日か商品設定を確かめてください（' + (m.storeLabel || L.store) + '　' + pages + ' / ' + pages + '）' })
      ].concat(m.outOfCandidates.map(function (e) { return h('div', { 'class': P + 'outrow', text: outLine(e) }); }))));
    }
    doc.body.appendChild(region);
    doc.documentElement.classList.add('osechi-printing');
  }
  function outLine(e) { return e.no + '番 ' + e.name + '　受渡日 ' + e.date + '　' + e.qty + ' 個（申込書 ' + e.orderCount + ' 件）'; }
  /**
   * 印刷用の領域（A4 横・1ページ15行＝ひな形と同じ）。1枚に収まるように、列の幅・字の大きさ・行の高さを決める
   *   （印刷できる高さ 194mm ＝ 見出し 約7mm＋列の見出し 約10mm＋15行×10.2mm＝約170mm・残り約20mm は字体の違いの余裕。行の高さは枠と余白を含む＝box-sizing。字は2行で打ち切る）。
   *   見出し（商品名・店渡し/宅配・お渡し日・店名・作成日時）は表の thead に入れる＝万一紙が分かれても各枚に出る
   */
  var PRINT_COLS = [['n', 'osechi-cn'], ['zip', 'osechi-cz'], ['tel', 'osechi-ct'], ['address', 'osechi-ca'], ['name', 'osechi-cm'], ['zip', 'osechi-cz'], ['tel', 'osechi-ct'], ['address', 'osechi-ca'], ['name', 'osechi-cm'], ['qty', 'osechi-cq']];
  function buildPrint(pages, method) {
    removePrint();
    var h = L.h, doc = root.document;
    var now = new Date(), p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    var made = now.getFullYear() + '/' + p2(now.getMonth() + 1) + '/' + p2(now.getDate()) + ' ' + p2(now.getHours()) + ':' + p2(now.getMinutes());
    var delivery = method === 'delivery';
    var region = h('div', { id: PRINT_ID, 'class': 'osechi-print', 'aria-hidden': 'true' });
    var cell = function (text, cls) { return h('td', { 'class': cls || null }, h('div', { 'class': 'osechi-pc', text: text })); };
    pages.forEach(function (pg, pi) {
      var dates = (L.host.idx && L.host.idx.byNo[pg.no] && L.host.idx.byNo[pg.no].dates.join('・')) || '12/31';
      var titleRow = h('tr', { 'class': 'osechi-pheadrow' }, h('th', { colspan: String(PRINT_COLS.length), scope: 'colgroup' }, h('div', { 'class': 'osechi-phead' }, [
        h('span', { 'class': 'osechi-ptitle', text: pg.title }),
        h('span', { 'class': 'osechi-pmark', text: METHOD_MARK[method] + '　' + (delivery ? '宅配日' : 'お渡し日') + '　' + dates }),
        h('span', { 'class': 'osechi-pmeta', text: L.store + '店　作成 ' + made + '　' + (pi + 1) + ' / ' + pages.length })
      ])));
      var head1 = [h('th', { rowspan: '2', 'class': 'osechi-pn', text: '番号' }), h('th', { colspan: '4', text: 'お届け先' }), h('th', { colspan: '4', text: 'ご依頼主' }), h('th', { rowspan: '2', 'class': 'osechi-pq', text: '数量' })];
      var head2 = [];
      [0, 1].forEach(function () { PARTY_COLS.forEach(function (c) { head2.push(h('th', { text: c[1] })); }); });
      var rows = [];
      for (var i = 0; i < PRINT_ROWS; i++) {
        var r = pg.rows[i];
        var cells = [cell(String(pg.startNo + i), 'osechi-pn')];
        PARTY_COLS.forEach(function (c) { cells.push(cell(r && delivery ? r.receiver[c[0]] : '')); });
        PARTY_COLS.forEach(function (c) { cells.push(cell(r ? r.requester[c[0]] : '')); });
        cells.push(cell(r ? String(r.qty) : '', 'osechi-pq'));
        rows.push(h('tr', null, cells));
      }
      region.appendChild(h('section', { 'class': 'osechi-ppage' }, [
        h('table', { 'class': 'osechi-ptable' }, [
          h('colgroup', null, PRINT_COLS.map(function (c) { return h('col', { 'class': c[1] }); })),
          h('thead', null, [titleRow, h('tr', null, head1), h('tr', null, head2)]),
          h('tbody', null, rows)
        ])
      ]));
    });
    doc.body.appendChild(region);
    doc.documentElement.classList.add('osechi-printing');
  }
  /** 印刷用の領域を消す（個人情報を画面に残さない） */
  function removePrint() {
    if (L && L.printTimer) { clearTimeout(L.printTimer); L.printTimer = 0; }
    if (typeof document === 'undefined') return;
    var el = document.getElementById(PRINT_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    document.documentElement.classList.remove('osechi-printing');
  }

  // ---- 見た目（JS から1回だけ差し込む。色は「おせち」） ----
  var CSS = [
    '.osechi-list{display:block}',
    '.osechi-lstore{display:flex;flex-direction:column;gap:6px}',
    // 全店の注文（本部だけ）: 店を選ぶ欄の下に、区切りの線を引いて1つ（店ごとの操作と混ぜない）
    '.osechi-lall{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;margin-top:4px;padding-top:8px;border-top:1px dashed #d8c3a5}',
    // PC では文字の幅のボタン＋説明を横に（1つだけのボタンを全幅にしない）。スマホは押しやすく全幅
    '.osechi-lall>.osechi-btn{min-height:48px;font-size:16px;width:auto;flex:0 0 auto;padding:8px 24px}',
    '@media (max-width:600px){.osechi-lall>.osechi-btn{width:100%;flex:1 1 100%}}',
    '.osechi-wrap.osechi-lwide{max-width:1480px}',
    '.osechi-lrules{margin:2px 2px 6px;line-height:1.55}',
    '.osechi-lrules>summary{cursor:pointer;font-weight:800;color:#6e1521;min-height:32px;padding:4px 0}',
    '.osechi-lrules>p{margin:4px 0 0}',
    '.osechi-ldead{border-radius:14px;padding:10px 14px;margin:0 0 8px;background:#fff8e1;border:2px solid #c9a227;color:#3d2a20}',
    '.osechi-ldead-main{font-size:19px;font-weight:900}',
    '.osechi-ldead-sub{font-size:16px;font-weight:800;margin-top:2px}',
    '.osechi-ldead-today{background:#8f1d2c;border-color:#6e1521;color:#fff}',
    '.osechi-ltabs{display:flex;gap:6px;margin:8px 0}',
    '.osechi-ltabs>.osechi-btn{flex:1 1 0;min-height:50px;font-size:18px}',
    '.osechi-ltabs>.osechi-btn.osechi-on{background:#8f1d2c;color:#fff;border-color:#6e1521}',
    '.osechi-lactions{margin:0 0 8px}',
    '.osechi-lactions .osechi-btn{min-height:50px;font-size:17px}',
    '.osechi-lsearch{margin:0 0 6px}',
    '.osechi-lblock{background:#fff;border:2px solid #e6dccd;border-radius:14px;margin:0 0 10px;overflow:hidden}',
    '.osechi-lblock-empty{opacity:.8}',
    '.osechi-lempty{background:#faf6f0}',
    '.osechi-lempty .osechi-lblock{margin:0 0 6px}',
    '.osechi-lhead{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;text-align:left;background:#f3e7d6;border:0;padding:10px 12px;cursor:pointer;font-family:inherit;color:#3d2a20}',
    '.osechi-lhead-title::before{content:"▶ ";font-size:14px;color:#6e1521}',
    '.osechi-lhead[aria-expanded="true"] .osechi-lhead-title::before{content:"▼ "}',
    '.osechi-lhead-title{font-size:17px;font-weight:900}',
    '.osechi-lhead-meta{font-size:15px;font-weight:700;color:#4a4f57}',
    '.osechi-lbody{padding:6px}',
    '.osechi-lscroll{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%}',
    '.osechi-ltable{width:100%;border-collapse:collapse;font-size:15px}',
    '.osechi-ltable th,.osechi-ltable td{border:1px solid #e6dccd;padding:5px 6px;text-align:left;vertical-align:top;word-break:break-word}',
    '.osechi-ltable thead th{background:#faf2e6;position:sticky;top:0;z-index:1;font-size:14px}',
    '.osechi-lrow{cursor:pointer}',
    '.osechi-lrow:hover,.osechi-lrow:focus{background:#fff8e1;outline:3px solid #e2b93b;outline-offset:-3px}',
    '.osechi-ln{text-align:center!important;font-weight:900;white-space:nowrap}',
    '.osechi-lqty{white-space:nowrap;font-weight:800}',
    '.osechi-lqty2{color:#8f1d2c;font-size:18px;font-weight:900;background:#fdecec}',
    '.osechi-lcont td{background:#f6f1ea;font-weight:900;color:#6e1521}',
    '.osechi-lsub{font-size:18px;font-weight:900;color:#5a1019;margin:14px 0 6px}',
    '.osechi-stable{border-collapse:separate;border-spacing:0;font-size:14px;min-width:100%}',
    '.osechi-stable th,.osechi-stable td{border-right:1px solid #e6dccd;border-bottom:1px solid #e6dccd;padding:4px 6px;text-align:right;white-space:nowrap;background:#fff}',
    '.osechi-stable thead th{position:sticky;top:0;z-index:2;background:#f3e7d6;text-align:center}',
    '.osechi-stable .osechi-sfix{position:sticky;left:0;z-index:1;text-align:left;background:#faf2e6}',
    '.osechi-stable thead .osechi-sfix{z-index:3}',
    '.osechi-stable th.osechi-sfix{white-space:normal;min-width:6.5em;max-width:9em}',   // 長い行の名前で列を広げない（折り返す）
    '.osechi-stable .osechi-snow th,.osechi-stable .osechi-snow td{background:#fff8e1}',
    '.osechi-stable .osechi-stotal th,.osechi-stable .osechi-stotal td{font-weight:900;background:#f6f1ea;border-top:2px solid #c9a227}',
    '.osechi-stable .osechi-spending th,.osechi-stable .osechi-spending td{font-style:italic;background:#eef5ff}',
    '.osechi-stot{font-weight:900}',
    '.osechi-sscroll{max-height:70vh;overflow:auto;border:1px solid #e6dccd;border-radius:10px}',
    '.osechi-stable-sand{min-width:auto}',
    '.osechi-lskeleton{color:#4a4f57;display:flex;align-items:center}',
    // 読み直しの印（一覧のすぐ上・一覧はそのまま使える）・直したばかりの行の印
    '.osechi-lfresh{margin:0 0 4px}',
    '.osechi-lfresh-on{display:flex;align-items:center;gap:2px;font-size:15px;font-weight:800;color:#5a1019;background:#fff8e1;border:1px solid #e2c675;border-radius:10px;padding:6px 10px}',
    '.osechi-lfresh-ng{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px}',
    '.osechi-lfresh-ng>.osechi-btn{width:auto;min-height:40px;font-size:15px;padding:4px 14px}',
    '.osechi-lpend{display:inline-block;margin-left:6px;padding:0 8px;border-radius:999px;background:#e8f3ec;border:1px solid #7fb894;color:#1d5b33;font-size:13px;font-weight:800;line-height:1.6;white-space:nowrap}',
    '.osechi-lrow-pending>td{background:#f4faf6}',
    // 「受注なし」の札（注文の無い商品・日を空白に見せない）・受付係員（空は「記載なし」＝読める濃さの灰）
    '.osechi-lnone{display:inline-block;padding:0 8px;border-radius:999px;background:#eceff3;border:1px solid #c5ccd6;color:#3f4650;font-size:14px;font-weight:800;line-height:1.6}',
    '.osechi-lrcp-none{color:#5f6670}',
    '.osechi-snone{color:#5f6670;font-size:13px;font-weight:700}',
    // 切り替えは4つ。狭い画面では「店内受注品一覧」を2段目に1つで置く（4つを1段に詰めると名前が折れて読めない）
    '@media (max-width:760px){.osechi-ltabs{flex-wrap:wrap}.osechi-ltabs>[data-tab="production"]{flex:1 1 100%}}',
    // ---- 店内受注品一覧（画面）----
    '.osechi-prod-actions>.osechi-btn-row{margin-top:0}',
    '.osechi-prod-intro{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;margin:0 0 6px}',
    '.osechi-prod-intro>p{flex:1 1 300px;margin:0}',
    '.osechi-prod-reload{width:auto;min-height:44px;font-size:16px;padding:6px 14px}',
    '.osechi-prod-days{display:grid;grid-template-columns:repeat(auto-fit,minmax(106px,1fr));gap:6px;margin:6px 0 10px}',
    '.osechi-prod-day{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:56px;padding:4px 6px;border-radius:12px;border:2px solid #d8cbb8;background:#fff;color:#3d2a20;font-family:inherit;cursor:pointer;line-height:1.25;-webkit-tap-highlight-color:transparent}',
    '.osechi-prod-day.osechi-on{background:#8f1d2c;border-color:#6e1521;color:#fff}',
    '.osechi-prod-day:focus-visible{outline:3px solid #e2b93b;outline-offset:2px}',
    '.osechi-prod-dlab{font-size:17px;font-weight:900;white-space:nowrap}',
    '.osechi-prod-dsub{font-size:13px;font-weight:700}',
    '.osechi-prod-daynil:not(.osechi-on) .osechi-prod-dsub{color:#5f6670}',
    '.osechi-prod-sec{background:#fff;border:2px solid #e6dccd;border-radius:14px;padding:10px 10px 8px;margin:0 0 10px}',
    '.osechi-prod-title{display:flex;align-items:baseline;justify-content:space-between;gap:4px 10px;flex-wrap:wrap}',
    '.osechi-prod-title>h3{margin:0;font-size:22px;font-weight:900;color:#5a1019}',
    '.osechi-prod-store{font-size:17px;font-weight:900}',
    '.osechi-prod-sub{font-size:15px;font-weight:700;color:#3d2a20;margin:2px 0 8px}',
    '.osechi-prod-subwarn{color:#b42318}',
    '.osechi-prod-note{margin:8px 0 0;line-height:1.5}',
    // 表（PC）: 列の見出しは本文の流れに合わせて上に残す（表を横のスクロールの枠に入れない＝入りきらなければカードにする）
    '.osechi-prod-table{width:100%;border-collapse:separate;border-spacing:0;font-size:15px}',
    '.osechi-prod-table th,.osechi-prod-table td{border-right:1px solid #d9cfbf;border-bottom:1px solid #d9cfbf;padding:5px 6px;text-align:center;vertical-align:middle;background:#fff}',
    '.osechi-prod-table tr>:first-child{border-left:1px solid #d9cfbf}',
    '.osechi-prod-hrow>th{position:sticky;top:0;z-index:2;background:#f3e7d6;font-size:13px;font-weight:800;line-height:1.25;color:#3d2a20}',
    '.osechi-prod-hrow:first-child>th{border-top:1px solid #d9cfbf}',
    '.osechi-prod-hslots{height:30px;box-sizing:border-box;white-space:nowrap}',
    '.osechi-prod-hrow2>th{top:30px}',
    '.osechi-prod-hname{min-width:9em}.osechi-prod-hs{min-width:2.9em}.osechi-prod-hsx{min-width:4.8em}.osechi-prod-hqty,.osechi-prod-hearly{min-width:4.6em}',
    '.osechi-prod-grp>th{text-align:left;font-size:16px;font-weight:900;color:#3d2a20;padding:6px 10px}',
    '.osechi-prod-ga>th{background:#fce4d6}.osechi-prod-gb>th{background:#ddebf7}.osechi-prod-gc>th{background:#e2efda}.osechi-prod-go>th{background:#ededed}.osechi-prod-gn>th{background:#fff2cc}',
    '.osechi-prod-empty>td{text-align:left;color:#5f6670;font-size:14px}',
    '.osechi-prod-no{font-weight:800;white-space:nowrap}',
    '.osechi-prod-name{text-align:left!important;font-weight:700;font-size:15px}',
    '.osechi-prod-has{font-size:20px;font-weight:900;color:#1f2328}',
    '.osechi-prod-nil{font-size:13px;font-weight:700;color:#5f6670;white-space:nowrap}',
    '.osechi-prod-early{font-size:17px;font-weight:900;white-space:nowrap}',
    '.osechi-prod-dim{font-size:13px;font-weight:700;color:#5f6670}',
    '.osechi-prod-slot{font-size:17px;font-weight:700}',
    '.osechi-prod-rownil>*{background:#fafafa}',
    // カード（狭い画面・表が入りきらない幅）: 1商品＝1枚。番号・商品名・合計 → いちばん早い受取 → 時刻ごとの個数（数のある列だけ）
    '.osechi-prod-cards .osechi-prod-table,.osechi-prod-cards .osechi-prod-table tbody{display:block}',
    '.osechi-prod-cards .osechi-prod-table thead{display:none}',
    '.osechi-prod-cards .osechi-prod-table tr{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px}',
    '.osechi-prod-cards .osechi-prod-table tr>*{display:block;border:0;padding:0;text-align:left}',
    '.osechi-prod-cards tr.osechi-prod-grp{margin:12px 0 6px}',
    '.osechi-prod-cards tr.osechi-prod-grp>th{flex:1 1 100%;padding:6px 10px;border-radius:10px}',
    '.osechi-prod-cards tr.osechi-prod-row{border:2px solid #e6dccd;border-radius:12px;padding:8px 10px;margin:0 0 8px;background:#fff}',
    '.osechi-prod-cards tr.osechi-prod-rownil{padding:6px 10px;background:#fafafa}',
    '.osechi-prod-cards tr.osechi-prod-row>*{background:transparent}',
    '.osechi-prod-cards .osechi-prod-no{flex:0 0 auto;min-width:1.6em}',
    '.osechi-prod-cards .osechi-prod-name{flex:1 1 0;min-width:0}',
    '.osechi-prod-cards .osechi-prod-qty{flex:0 0 auto}',
    '.osechi-prod-cards .osechi-prod-has::after{content:" 個";font-size:15px;font-weight:800}',
    '.osechi-prod-cards .osechi-prod-early{flex:1 1 100%}',
    '.osechi-prod-cards .osechi-prod-early::before{content:attr(data-label) "　";font-size:14px;font-weight:800;color:#6e1521}',
    '.osechi-prod-cards tr.osechi-prod-row>.osechi-prod-slot{flex:0 0 auto;background:#f6f1ea;border:1px solid #d9cfbf;border-radius:8px;padding:2px 8px}',
    '.osechi-prod-cards .osechi-prod-slot::before{content:attr(data-label) " ";font-size:14px;font-weight:800;color:#6e1521}',
    '.osechi-prod-cards .osechi-prod-slot::after{content:" 個";font-size:14px}',
    '.osechi-prod-cards .osechi-prod-table .osechi-prod-zero{display:none}',   // 数の無い列・受注なしの早い受取は、カードでは出さない（表では空のます）
    '.osechi-prod-cards tr.osechi-prod-empty{padding:2px 10px 6px}',
    '.osechi-prod-cards tr.osechi-prod-empty>td{flex:1 1 100%}',
    '.osechi-prod-out{font-weight:800}',
    '.osechi-prod-warn{font-size:15px;font-weight:600;line-height:1.5;padding:8px 12px}',
    '.osechi-prod-dhead{font-size:14px;font-weight:800;color:#6e1521;margin:4px 0 0}',
    '.osechi-prod-dayny .osechi-prod-dlab{color:#b42318}.osechi-prod-dayny.osechi-on .osechi-prod-dlab{color:#fff}',
    // スマホ（幅が狭い）: 1行をカードに（見出しは各欄の前に）
    '@media (min-width:761px){.osechi-ltable th{white-space:nowrap}.osechi-ltable td.osechi-lnw,.osechi-ltable td.osechi-lrecv,.osechi-ltable td.osechi-lrcp{white-space:nowrap}}',
    '@media (min-width:1000px){.osechi-lactions{display:flex;gap:8px;align-items:stretch}.osechi-lactions>.osechi-btn{flex:3 1 0}.osechi-lactions>.osechi-btn-row{flex:4 1 0;margin-top:0}}',
    '@media (max-width:760px){',
    '.osechi-ltable,.osechi-ltable tbody,.osechi-ltable tr,.osechi-ltable td{display:block;width:100%}',
    '.osechi-ltable thead{display:none}',
    '.osechi-ltable tr.osechi-lrow{border:2px solid #e6dccd;border-radius:12px;margin:0 0 8px;padding:4px 6px;background:#fff}',
    // 画面の外のカードは描かない（遅い端末で 230 行: CPU 4倍遅くの計測で 一覧が出るまで 約1.9秒 → 約0.6〜0.8秒・続きは 約1.5秒 → 約0.3秒。対応しない端末は、ふつうに全部描く）
    '.osechi-ltable tr.osechi-lrow{content-visibility:auto;contain-intrinsic-size:auto 230px}',
    '.osechi-ltable td{border:0;border-bottom:1px dashed #eee3d3;display:grid;grid-template-columns:7.5em minmax(0,1fr);gap:6px;padding:4px 2px}',
    '.osechi-ltable td::before{content:attr(data-label);font-weight:800;color:#6e1521;font-size:13px}',
    '.osechi-ltable td.osechi-ln{text-align:left!important}',
    // 直した行の印は値の列に置く（見出しの狭い列に入ると、印の枠から字があふれる）
    '.osechi-ltable td .osechi-lpend{grid-column:2;justify-self:start;margin-left:0;white-space:normal}',
    '.osechi-lcont td{display:block;border-radius:10px;margin:4px 0}',
    '.osechi-lcont td::before{content:none}',
    '}',
    // 印刷: 印刷用の領域だけを出す（A4 横・商品ごとに改ページ・ひな形に近い表）
    '#osechi-print{display:none}',
    '@media print{',
    '@page{size:A4 landscape;margin:8mm}',
    'html.osechi-printing body>*:not(#osechi-print){display:none!important}',
    'html.osechi-printing body{overflow:visible!important;background:#fff!important;margin:0!important;padding:0!important}',
    'html.osechi-printing #osechi-print{display:block!important;position:static;color:#000;font-family:"Yu Gothic","Hiragino Sans","Meiryo",sans-serif}',
    // 1ページ15行が A4 横の1枚に収まる大きさ（印刷できる高さ 194mm）。商品ごとに改ページ
    '.osechi-ppage{break-after:page;page-break-after:always;break-inside:avoid;page-break-inside:avoid}',
    '.osechi-ppage:last-child{break-after:auto;page-break-after:auto}',
    '.osechi-ptable{width:100%;border-collapse:collapse;table-layout:fixed;font-size:8.5pt;line-height:1.2}',
    '.osechi-ptable thead{display:table-header-group}',
    '.osechi-ptable th,.osechi-ptable td{box-sizing:border-box;border:0.3mm solid #000;padding:0.6mm 1mm;vertical-align:middle;word-break:break-all;overflow:hidden}',
    '.osechi-ptable th{background:#eee;font-weight:700;text-align:center}',
    '.osechi-ptable tbody td{height:10.2mm}',
    '.osechi-pc{max-height:2.4em;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
    '.osechi-ptable tr.osechi-pheadrow th{background:#fff;border:0;padding:0 0 1.5mm 0;text-align:left;font-weight:400}',
    '.osechi-phead{display:flex;flex-wrap:nowrap;align-items:baseline;gap:6mm;white-space:nowrap;overflow:hidden}',
    '.osechi-ptitle{font-size:12pt;font-weight:700}',
    '.osechi-pmark{font-size:10.5pt;font-weight:700}',
    '.osechi-pmeta{font-size:8.5pt;margin-left:auto}',
    // 列の幅（住所を広く・郵便と電話は狭く）。住所は残り（約63mm×2）
    'col.osechi-cn{width:8mm}col.osechi-cz{width:16mm}col.osechi-ct{width:24mm}col.osechi-cm{width:27mm}col.osechi-cq{width:10mm}',
    '.osechi-pn,.osechi-pq{text-align:center}',
    '.osechi-ptable td.osechi-pq{font-weight:700}',
    // 店内受注品一覧（A4 横・1日＝1ページ・xlsx に近い見た目）。行の高さ・時台の列の幅は、いちばん商品の多い日が1枚に収まるように JS が段を選ぶ
    '.osechi-prodp{-webkit-print-color-adjust:exact;print-color-adjust:exact}',
    '.osechi-prodp-page{break-after:page;page-break-after:always}',
    '.osechi-prodp-page:last-child{break-after:auto;page-break-after:auto}',
    '.osechi-prodp-table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:9pt;line-height:1.15}',
    '.osechi-prodp-table thead{display:table-header-group}',
    '.osechi-prodp-table th,.osechi-prodp-table td{box-sizing:border-box;border:0.3mm solid #000;padding:0.4mm 1mm;vertical-align:middle;text-align:center;overflow:hidden;font-weight:400}',
    '.osechi-prodp-trow>th,.osechi-prodp-srow>th{border:0!important;text-align:left!important;padding:0 0 1mm!important}',
    '.osechi-prodp-thead{display:flex;align-items:baseline;justify-content:space-between;gap:6mm;white-space:nowrap}',
    '.osechi-prodp-title{font-size:16pt;font-weight:700}',
    '.osechi-prodp-store{font-size:13pt;font-weight:700}',
    '.osechi-prodp-srow>th{font-size:9.5pt}',
    '.osechi-prodp-subwarn{color:#c00000;font-weight:700!important}',
    '.osechi-prodp-hrow>th{background:#d9d9d9;font-weight:700;font-size:8pt;padding:0.6mm 0.5mm}',
    '.osechi-prodp-grp>th{text-align:left;font-size:11pt;font-weight:700;padding:1mm 1.5mm;height:7mm}',
    '.osechi-prodp-empty>td{text-align:left;color:#595959;height:6mm}',
    '.osechi-prodp-table th.osechi-prodp-name{text-align:left}',
    '.osechi-prodp-nm{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-all;font-size:10pt}',
    '.osechi-prodp-no{font-size:10.5pt}',
    '.osechi-prodp-table td.osechi-prodp-has{font-size:15pt;font-weight:700}',
    '.osechi-prodp-nil{font-size:8.5pt;color:#595959}',
    '.osechi-prodp-table td.osechi-prodp-early{font-size:12.5pt;font-weight:700}',
    '.osechi-prodp-table td.osechi-prodp-dim{font-size:8.5pt;font-weight:400;color:#595959}',
    '.osechi-prodp-slot{font-size:12pt}',
    '.osechi-prodp-note{font-size:7.5pt;color:#404040;margin-top:1.2mm;line-height:1.35}',
    '.osechi-prodp-outhead{font-size:11pt;font-weight:700;color:#c00000;margin:2mm 0}',
    '.osechi-prodp-outrow{font-size:11pt;padding:1mm 0;border-bottom:0.2mm solid #999}',
    'col.osechi-prodp-cno{width:9mm}col.osechi-prodp-cqty{width:17mm}col.osechi-prodp-cearly{width:20mm}col.osechi-prodp-cx{width:18mm}',
    [7, 8, 9, 10].map(function (w) { return '.osechi-prodp-w' + w + ' col.osechi-prodp-ch{width:' + w + 'mm}'; }).join(''),
    [6, 7, 8, 9, 10, 11].map(function (r) { return '.osechi-prodp-r' + r + ' .osechi-prodp-row>*{height:' + r + 'mm}'; }).join(''),
    '.osechi-prodp-r6 .osechi-prodp-nm,.osechi-prodp-r7 .osechi-prodp-nm,.osechi-prodp-r8 .osechi-prodp-nm{-webkit-line-clamp:1}',
    '}'
  ].join('\n');
  function injectStyle() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  // ===== 公開 =====
  var publicApi = Object.freeze({ build: BUILD, render: render, dispose: dispose, forget: forget });
  if (typeof document !== 'undefined' && root && !root.OsechiListModule) {
    try { Object.defineProperty(root, 'OsechiListModule', { value: publicApi, writable: false, configurable: false, enumerable: true }); }
    catch (e) { /* 定義できない環境では出さない */ }
  }
  if (typeof module === 'object' && module && module.exports) {
    module.exports = {
      OsechiListModule: publicApi,
      _test: {
        BUILD: BUILD, PRINT_ROWS: PRINT_ROWS, REPORT_RULES: REPORT_RULES, searchText: searchText, searchDigits: searchDigits, rowMatches: rowMatches, parseQuery: parseQuery, SN: SN,
        cleanRow: cleanRow, cleanList: cleanList, buildData: buildData, patchData: patchData, hhmm: hhmm, loadedRows: loadedRows, filterBlocks: filterBlocks, base64ToBytes: base64ToBytes, isZipBytes: isZipBytes,
        mdDow: mdDow, printPages: printPages, summaryTable: summaryTable, sandwichRows: sandwichRows, deadlineView: deadlineView,
        cleanText: cleanText, CTRL_RE: CTRL_RE, TOTAL_ROWS_MAX: TOTAL_ROWS_MAX, SEARCH_MAX: SEARCH_MAX, searchLimit: searchLimit, MEM_MAX: MEM_MAX, MEM_TTL_MS: MEM_TTL_MS,
        TABS: TABS, NONE_MARK: NONE_MARK, RECEPTIONIST_NONE: RECEPTIONIST_NONE, PROD_MAX: PROD_MAX, DOWNLOADS: DOWNLOADS,
        cleanProduction: cleanProduction, defaultProdDay: defaultProdDay, prodGroupTitle: prodGroupTitle, prodDaySub: prodDaySub, prodPrintLayout: prodPrintLayout,
        DEPT_CLASS: DEPT_CLASS, groupClass: groupClass,
        PROD_HEADS: PROD_HEADS, PROD_SLOTS_HEAD: PROD_SLOTS_HEAD, slotHeadParts: slotHeadParts, prodRowTexts: prodRowTexts
      }
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
