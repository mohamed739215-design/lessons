/* =====================================================================
 * المزامنة السحابية (Firebase) — المرحلة 1
 *  - تسجيل الدخول بحساب السنتر
 *  - رفع المجموعات والطلاب إلى السحابة (يدوي)
 *  - تنزيل المجموعات والطلاب من السحابة ودمجها (يدوي)
 * لا يغيّر أي بيانات تلقائياً، ولا يعمل شيء إلا بضغطة زر من المستخدم.
 * ===================================================================== */
(function () {
    'use strict';

    const FIREBASE_CONFIG = {
        apiKey: "AIzaSyBQmZHmWWCPJuhNPibknII_uXKEEN6Gs2U",
        authDomain: "yaqeen-center.firebaseapp.com",
        projectId: "yaqeen-center",
        storageBucket: "yaqeen-center.firebasestorage.app",
        messagingSenderId: "798090050338",
        appId: "1:798090050338:web:b27aec347ed8488d07437b"
    };
    const SDK_VERSION = '10.14.1';
    const DEFAULT_EMAIL = 'yaqeeny197@gmail.com';
    const PHASE1_TABLES = ['groups', 'students'];   // ترتيب مهم: المجموعات أولاً
    const META_KEYS = ['_ts', '_by'];

    // ---------- أدوات نقية (قابلة للاختبار) ----------
    function stableStringify(v) {
        if (v === null || typeof v !== 'object') return JSON.stringify(v);
        if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
        return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
    }
    function stripMeta(rec) {
        const out = {};
        Object.keys(rec || {}).forEach(k => { if (!META_KEYS.includes(k)) out[k] = rec[k]; });
        return out;
    }
    function cleanForCloud(rec, deviceId) {
        const o = JSON.parse(JSON.stringify(rec));        // يحذف undefined
        o._ts = Date.now();
        o._by = deviceId;
        return o;
    }
    // خطة الدمج: ما يُضاف / ما يختلف / ما يطابق
    function planMerge(localArr, remoteArr) {
        const local = new Map((localArr || []).map(r => [String(r.id), r]));
        const toAdd = [], toDiff = [];
        let same = 0;
        (remoteArr || []).forEach(raw => {
            const r = stripMeta(raw);
            const l = local.get(String(r.id));
            if (!l) toAdd.push(r);
            else if (stableStringify(stripMeta(JSON.parse(JSON.stringify(l)))) === stableStringify(r)) same++;
            else toDiff.push(r);
        });
        return { toAdd, toDiff, same };
    }

    // ---------- الحالة ----------
    let fb = null;               // { app, auth, fs, authMod, fsMod }
    let currentUser = null;
    const deviceId = (function () {
        let id = null;
        try { id = localStorage.getItem('sync_device_id'); } catch (e) { }
        if (!id) {
            id = 'dev-' + Math.random().toString(36).slice(2, 10);
            try { localStorage.setItem('sync_device_id', id); } catch (e) { }
        }
        return id;
    })();

    async function loadSdk() {
        if (fb) return fb;
        const base = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/';
        const [appMod, authMod, fsMod] = await Promise.all([
            import(base + 'firebase-app.js'),
            import(base + 'firebase-auth.js'),
            import(base + 'firebase-firestore.js')
        ]);
        const app = appMod.initializeApp(FIREBASE_CONFIG);
        const auth = authMod.getAuth(app);
        const fs = fsMod.getFirestore(app);
        fb = { app, auth, fs, authMod, fsMod };
        authMod.onAuthStateChanged(auth, (u) => { currentUser = u || null; renderAuthState(); });
        return fb;
    }

    // ---------- الواجهة ----------
    const $ = (id) => document.getElementById(id);
    function log(msg, kind) {
        const box = $('cloud-sync-log');
        if (!box) return;
        const colors = { ok: '#16a34a', err: '#dc2626', info: 'var(--text-muted)' };
        const line = document.createElement('div');
        line.style.color = colors[kind || 'info'];
        line.textContent = new Date().toLocaleTimeString('ar-EG') + ' — ' + msg;
        box.prepend(line);
    }
    function setBusy(b) {
        ['cloud-btn-login', 'cloud-btn-upload', 'cloud-btn-download', 'cloud-btn-logout'].forEach(id => {
            const el = $(id); if (el) el.disabled = b;
        });
    }
    function renderAuthState() {
        const st = $('cloud-sync-status'); if (!st) return;
        const loginBox = $('cloud-login-box'), actions = $('cloud-actions-box');
        if (currentUser) {
            st.innerHTML = '<span style="color:#16a34a;font-weight:700;">● متصل بالحساب:</span> <span dir="ltr">' + currentUser.email + '</span>';
            if (loginBox) loginBox.style.display = 'none';
            if (actions) actions.style.display = 'block';
        } else {
            st.innerHTML = '<span style="color:#dc2626;font-weight:700;">● غير مسجّل الدخول</span>';
            if (loginBox) loginBox.style.display = 'block';
            if (actions) actions.style.display = 'none';
        }
    }
    function buildPanel() {
        const section = $('backup-section');
        if (!section || $('cloud-sync-card')) return !!$('cloud-sync-card');
        const card = document.createElement('div');
        card.id = 'cloud-sync-card';
        card.style.cssText = 'margin:1rem 0; padding:1rem 1.1rem; border:2px solid #2563eb; border-radius:18px; background:#fff;';
        card.innerHTML =
            '<h3 style="margin:0 0 0.4rem; color:#1d4ed8;">☁️ المزامنة السحابية <small style="font-size:0.7rem;color:var(--text-muted);">(المرحلة 1: المجموعات والطلاب)</small></h3>' +
            '<div id="cloud-sync-status" style="margin-bottom:0.6rem;">…</div>' +
            '<div id="cloud-login-box">' +
            '  <input id="cloud-email" type="email" dir="ltr" placeholder="البريد" value="' + DEFAULT_EMAIL + '" style="width:100%;padding:0.6rem;margin-bottom:0.5rem;border:1px solid var(--border);border-radius:10px;">' +
            '  <input id="cloud-pass" type="password" dir="ltr" placeholder="كلمة المرور" style="width:100%;padding:0.6rem;margin-bottom:0.5rem;border:1px solid var(--border);border-radius:10px;">' +
            '  <button id="cloud-btn-login" class="btn btn-primary" style="width:100%;">تسجيل الدخول للسحابة</button>' +
            '</div>' +
            '<div id="cloud-actions-box" style="display:none;">' +
            '  <button id="cloud-btn-upload" class="btn btn-primary" style="width:100%;margin-bottom:0.5rem;">⬆️ رفع المجموعات والطلاب إلى السحابة</button>' +
            '  <button id="cloud-btn-download" class="btn" style="width:100%;margin-bottom:0.5rem;border:1px solid var(--border);">⬇️ تنزيل من السحابة (دمج)</button>' +
            '  <button id="cloud-btn-logout" class="btn" style="width:100%;font-size:0.85rem;">تسجيل الخروج</button>' +
            '</div>' +
            '<div style="margin-top:0.6rem;font-size:0.75rem;color:var(--text-muted);">⚠️ احفظ نسخة احتياطية (حفظ نسخة الآن) قبل أي رفع أو تنزيل.</div>' +
            '<div id="cloud-sync-log" style="margin-top:0.6rem;font-size:0.78rem;max-height:160px;overflow:auto;"></div>';
        section.insertBefore(card, section.firstChild);
        $('cloud-btn-login').onclick = doLogin;
        $('cloud-btn-logout').onclick = doLogout;
        $('cloud-btn-upload').onclick = doUpload;
        $('cloud-btn-download').onclick = doDownload;
        renderAuthState();
        // نحمّل المكتبة في الخلفية لمعرفة حالة تسجيل الدخول المحفوظة
        loadSdk().catch(e => log('تعذّر تحميل مكتبة Firebase (تحقق من الإنترنت): ' + (e && e.message || e), 'err'));
        return true;
    }

    // ---------- العمليات ----------
    async function doLogin() {
        const email = ($('cloud-email').value || '').trim();
        const pass = $('cloud-pass').value || '';
        if (!email || !pass) { log('أدخل البريد وكلمة المرور', 'err'); return; }
        setBusy(true);
        try {
            const f = await loadSdk();
            await f.authMod.signInWithEmailAndPassword(f.auth, email, pass);
            $('cloud-pass').value = '';
            log('تم تسجيل الدخول بنجاح', 'ok');
        } catch (e) {
            const code = (e && e.code) || '';
            const msg = code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')
                ? 'البريد أو كلمة المرور غير صحيحة'
                : code.includes('network') ? 'لا يوجد اتصال بالإنترنت' : ('تعذّر تسجيل الدخول: ' + (code || e));
            log(msg, 'err');
        }
        setBusy(false);
    }
    async function doLogout() {
        try { const f = await loadSdk(); await f.authMod.signOut(f.auth); log('تم تسجيل الخروج', 'info'); } catch (e) { log('تعذّر الخروج: ' + e, 'err'); }
    }

    async function doUpload() {
        if (!currentUser) { log('سجّل الدخول أولاً', 'err'); return; }
        const groups = db.groups || [], students = db.students || [];
        if (!confirm('سيتم رفع ' + groups.length + ' مجموعة و' + students.length + ' طالب إلى السحابة.\nأي سجل له نفس المعرّف في السحابة سيُستبدل.\n\nهل حفظت نسخة احتياطية؟ المتابعة؟')) return;
        setBusy(true);
        try {
            const f = await loadSdk();
            const { collection, doc, writeBatch, getCountFromServer } = f.fsMod;
            for (const table of PHASE1_TABLES) {
                const rows = db[table] || [];
                for (let i = 0; i < rows.length; i += 400) {
                    const batch = writeBatch(f.fs);
                    rows.slice(i, i + 400).forEach(r => batch.set(doc(f.fs, table, String(r.id)), cleanForCloud(r, deviceId)));
                    await batch.commit();
                    log('رفع ' + table + ': ' + Math.min(i + 400, rows.length) + ' / ' + rows.length);
                }
            }
            const res = {};
            for (const table of PHASE1_TABLES) {
                const snap = await getCountFromServer(collection(f.fs, table));
                res[table] = snap.data().count;
            }
            const ok = res.groups === groups.length && res.students === students.length;
            log('تم الرفع. في السحابة الآن: ' + res.groups + ' مجموعة، ' + res.students + ' طالب' +
                (ok ? ' ✅ مطابق لما على الجهاز' : ' ⚠️ العدد يختلف عن الجهاز (قد تكون هناك سجلات أخرى في السحابة)'), ok ? 'ok' : 'info');
        } catch (e) {
            log('فشل الرفع: ' + ((e && e.code) || '') + ' ' + ((e && e.message) || e), 'err');
        }
        setBusy(false);
    }

    async function doDownload() {
        if (!currentUser) { log('سجّل الدخول أولاً', 'err'); return; }
        setBusy(true);
        try {
            const f = await loadSdk();
            const { collection, getDocs } = f.fsMod;
            const remote = {};
            for (const table of PHASE1_TABLES) {
                const snap = await getDocs(collection(f.fs, table));
                remote[table] = snap.docs.map(d => d.data());
            }
            const plans = {};
            PHASE1_TABLES.forEach(t => { plans[t] = planMerge(db[t] || [], remote[t]); });
            const addN = plans.groups.toAdd.length + plans.students.toAdd.length;
            const diffN = plans.groups.toDiff.length + plans.students.toDiff.length;
            log('في السحابة: ' + remote.groups.length + ' مجموعة، ' + remote.students.length + ' طالب. جديد عندك: ' + addN + ' | مختلف: ' + diffN + ' | مطابق: ' + (plans.groups.same + plans.students.same));
            if (addN === 0 && diffN === 0) { log('لا فروق، بياناتك مطابقة للسحابة ✅', 'ok'); setBusy(false); return; }
            if (!confirm('سيُضاف ' + plans.groups.toAdd.length + ' مجموعة و' + plans.students.toAdd.length + ' طالب جديد من السحابة.\nيوجد ' + diffN + ' سجل مختلف عن الموجود عندك.\n\nهل حفظت نسخة احتياطية؟ المتابعة بإضافة الجديد؟')) { setBusy(false); return; }
            let overwrite = false;
            if (diffN > 0) overwrite = confirm('يوجد ' + diffN + ' سجل مختلف عن نسخة السحابة.\n\nموافق = استبدالها بنسخة السحابة\nإلغاء = إبقاء ما عندك كما هو');
            for (const table of PHASE1_TABLES) {
                const changed = plans[table].toAdd.concat(overwrite ? plans[table].toDiff : []);
                if (changed.length) {
                    await StorageEngine.save(table, changed);
                    db[table] = await StorageEngine.getAll(table);   // إعادة التحميل من التخزين المحلي
                    log('تم حفظ ' + changed.length + ' سجل في ' + table, 'ok');
                }
            }
            if (typeof renderStudents === 'function') { try { renderStudents(); } catch (e) { } }
            if (typeof syncUIWithContext === 'function') { try { syncUIWithContext(); } catch (e) { } }
            if (typeof updateDashboardStats === 'function') { try { updateDashboardStats(); } catch (e) { } }
            log('اكتمل التنزيل ✅ (عندك الآن ' + db.groups.length + ' مجموعة، ' + db.students.length + ' طالب)', 'ok');
        } catch (e) {
            log('فشل التنزيل: ' + ((e && e.code) || '') + ' ' + ((e && e.message) || e), 'err');
        }
        setBusy(false);
    }

    // ---------- تشغيل ----------
    function start() {
        let tries = 0;
        const t = setInterval(() => {
            tries++;
            if (buildPanel() || tries > 60) clearInterval(t);
        }, 500);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

    window.CloudSync = { _test: { planMerge, stableStringify, stripMeta, cleanForCloud } };
})();
