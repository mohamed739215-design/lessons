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


    // ======================================================================
    //  محرّك المزامنة التلقائية (مصنع قابل للاختبار)
    //  - يعترض StorageEngine.save/delete ويرفع التغييرات فقط
    //  - يستمع لتغييرات السحابة ويطبّقها محلياً
    // ======================================================================
    const AUTO_TABLES = ['groups', 'students', 'attendance', 'payments', 'absenceSessions', 'studentHandouts', 'cycles'];

    function createSyncEngine(env) {
        const { fs, fsMod, getDb, SE, deviceId, onChange, log } = env;
        const TABLES = env.tables || AUTO_TABLES;
        const { collection, doc, writeBatch, getDocs, onSnapshot, deleteDoc } = fsMod;
        const idKey = (id) => String(id).replace(/\//g, '%2F');
        const hashOf = (r) => stableStringify(stripMeta(r));

        const pushed = {};          // table -> Map(id -> hash) آخر حالة معروفة في السحابة
        TABLES.forEach(t => { pushed[t] = new Map(); });
        const pending = new Map();  // "table|id" -> {table, rec, h}
        const stats = { pushed: 0, pulled: 0, conflicts: 0, errors: 0, deleted: 0 };
        let applying = 0, active = false, flushing = false, flushTimer = null, changeTimer = null;
        let unsubs = [], origSave = null, origDelete = null, chain = Promise.resolve();
        const skipOnce = new Set();   // سجلات متعارضة عند التشغيل: نتجاهل أول 'added' لها حتى لا نستبدلها

        // --- مساعدات الذاكرة ---
        function memFind(table, id) {
            const arr = getDb()[table];
            return Array.isArray(arr) ? arr.find(x => String(x.id) === String(id)) : undefined;
        }
        function memUpsert(table, rec) {
            const d = getDb();
            if (!Array.isArray(d[table])) { d[table] = [rec]; return; }
            const i = d[table].findIndex(x => String(x.id) === String(rec.id));
            if (i >= 0) d[table][i] = rec; else d[table].push(rec);
        }
        function memRemove(table, id) {
            const arr = getDb()[table];
            if (!Array.isArray(arr)) return;
            const i = arr.findIndex(x => String(x.id) === String(id));
            if (i >= 0) arr.splice(i, 1);
        }
        function notifyChange() {
            clearTimeout(changeTimer);
            changeTimer = setTimeout(() => { try { onChange && onChange(); } catch (e) { } }, 400);
        }

        // --- تطبيق تغيير قادم من السحابة (بدون إعادة رفعه) ---
        async function applyRemote(table, rec) {
            applying++;
            try {
                await origSave(table, [rec]);
                memUpsert(table, rec);
                pushed[table].set(String(rec.id), hashOf(rec));
                stats.pulled++;
            } finally { applying--; }
        }
        async function applyRemoteDelete(table, id) {
            applying++;
            try {
                if (memFind(table, id) !== undefined) {
                    await origDelete(table, memFind(table, id).id);
                    memRemove(table, id);
                    stats.deleted++;
                }
                pushed[table].delete(String(id));
            } finally { applying--; }
        }

        // --- الرفع ---
        function queuePush(table, data) {
            if (!pushed[table]) return;
            const arr = Array.isArray(data) ? data : [data];
            let added = 0;
            for (const rec of arr) {
                if (!rec || rec.id === undefined || rec.id === null) continue;
                const id = String(rec.id), h = hashOf(rec);
                if (pushed[table].get(id) === h) continue;
                pending.set(table + '|' + id, { table, rec: JSON.parse(JSON.stringify(rec)), h });
                added++;
            }
            if (added) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 700); }
        }
        async function flush() {
            if (flushing || !pending.size) return;
            flushing = true;
            const items = Array.from(pending.values());
            pending.clear();
            try {
                for (let i = 0; i < items.length; i += 400) {
                    const part = items.slice(i, i + 400);
                    const batch = writeBatch(fs);
                    part.forEach(it => batch.set(doc(fs, it.table, idKey(it.rec.id)), cleanForCloud(it.rec, deviceId)));
                    await batch.commit();
                    part.forEach(it => pushed[it.table].set(String(it.rec.id), it.h));
                    stats.pushed += part.length;
                }
            } catch (e) {
                stats.errors++;
                items.forEach(it => { if (!pending.has(it.table + '|' + it.rec.id)) pending.set(it.table + '|' + it.rec.id, it); });
                log && log('تعذّر الرفع (سيُعاد المحاولة): ' + ((e && e.code) || e), 'err');
                clearTimeout(flushTimer); flushTimer = setTimeout(flush, 5000);
            }
            flushing = false;
            if (pending.size && !flushTimer) flushTimer = setTimeout(flush, 700);
        }
        async function pushDelete(table, id) {
            try { await deleteDoc(doc(fs, table, idKey(id))); pushed[table].delete(String(id)); stats.pushed++; }
            catch (e) { stats.errors++; log && log('تعذّر رفع الحذف: ' + ((e && e.code) || e), 'err'); }
        }

        // --- الاستماع ---
        function handleSnapshot(table, snap) {
            const upserts = [], removes = [];
            snap.docChanges().forEach(ch => {
                if (ch.doc.metadata && ch.doc.metadata.hasPendingWrites) return;   // صدى كتابتنا المحلية
                const data = ch.doc.data();
                if (ch.type === 'added' && skipOnce.has(table + '|' + ch.doc.id)) { skipOnce.delete(table + '|' + ch.doc.id); return; }
                if (ch.type === 'removed') { removes.push(data && data.id !== undefined ? data.id : ch.doc.id); return; }
                if (data._by === deviceId) return;                                 // كتبناه نحن
                const rec = stripMeta(data);
                const local = memFind(table, rec.id);
                if (local && hashOf(local) === hashOf(rec)) { pushed[table].set(String(rec.id), hashOf(rec)); return; }
                upserts.push(rec);
            });
            if (!upserts.length && !removes.length) return;
            chain = chain.then(async () => {
                for (const rec of upserts) { try { await applyRemote(table, rec); } catch (e) { stats.errors++; log && log('تعذّر تطبيق سجل من السحابة (' + table + '): ' + e, 'err'); } }
                for (const id of removes) { try { await applyRemoteDelete(table, id); } catch (e) { stats.errors++; } }
                notifyChange();
            });
        }

        // --- مصالحة أولية عند التشغيل: لا نستبدل شيئاً مختلفاً، نضيف الناقص فقط ---
        async function reconcile() {
            const summary = {};
            for (const table of TABLES) {
                const snap = await getDocs(collection(fs, table));
                const remote = new Map(); snap.docs.forEach(d => { const r = stripMeta(d.data()); remote.set(String(r.id), r); });
                const local = Array.isArray(getDb()[table]) ? getDb()[table] : [];
                const localMap = new Map(local.map(r => [String(r.id), r]));
                let cloudOnly = 0, localOnly = 0, same = 0, conflict = 0;
                for (const [id, r] of remote) {
                    const l = localMap.get(id);
                    if (!l) { await applyRemote(table, r); cloudOnly++; }
                    else if (hashOf(l) === hashOf(r)) { pushed[table].set(id, hashOf(r)); same++; }
                    else { pushed[table].set(id, hashOf(l)); skipOnce.add(table + '|' + idKey(id)); conflict++; stats.conflicts++; }
                }
                for (const [id, l] of localMap) {
                    if (!remote.has(id)) { pending.set(table + '|' + id, { table, rec: JSON.parse(JSON.stringify(l)), h: hashOf(l) }); localOnly++; }
                }
                summary[table] = { cloudOnly, localOnly, same, conflict };
            }
            await flush();
            return summary;
        }

        async function start() {
            if (active) return null;
            origSave = SE.save.bind(SE);
            origDelete = SE.delete.bind(SE);
            const summary = await reconcile();
            SE.save = async function (table, data) {
                const r = await origSave(table, data);
                if (active && !applying) queuePush(table, data);
                return r;
            };
            SE.delete = async function (table, id) {
                const r = await origDelete(table, id);
                if (active && !applying && pushed[table]) await pushDelete(table, id);
                return r;
            };
            active = true;
            TABLES.forEach(table => {
                unsubs.push(onSnapshot(collection(fs, table), (snap) => handleSnapshot(table, snap),
                    (err) => { stats.errors++; log && log('انقطع الاستماع (' + table + '): ' + ((err && err.code) || err), 'err'); }));
            });
            notifyChange();
            return summary;
        }
        function stop() {
            active = false;
            unsubs.forEach(u => { try { u(); } catch (e) { } });
            unsubs = [];
            if (origSave) SE.save = origSave;
            if (origDelete) SE.delete = origDelete;
            origSave = origDelete = null;
        }
        return { start, stop, flush, stats, isActive: () => active, pendingCount: () => pending.size, _chain: () => chain };
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
        let fs;
        try {
            fs = fsMod.initializeFirestore(app, { localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() }) });
        } catch (e) { fs = fsMod.getFirestore(app); }
        fb = { app, auth, fs, authMod, fsMod };
        authMod.onAuthStateChanged(auth, (u) => { currentUser = u || null; renderAuthState(); onAuthChanged(); });
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
        renderAutoState();
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
            '<h3 style="margin:0 0 0.4rem; color:#1d4ed8;">☁️ المزامنة السحابية <small style="font-size:0.7rem;color:var(--text-muted);">(الرفع والتنزيل اليدوي + المزامنة التلقائية)</small></h3>' +
            '<div id="cloud-sync-status" style="margin-bottom:0.6rem;">…</div>' +
            '<div id="cloud-login-box">' +
            '  <input id="cloud-email" type="email" dir="ltr" placeholder="البريد" value="' + DEFAULT_EMAIL + '" style="width:100%;padding:0.6rem;margin-bottom:0.5rem;border:1px solid var(--border);border-radius:10px;">' +
            '  <input id="cloud-pass" type="password" dir="ltr" placeholder="كلمة المرور" style="width:100%;padding:0.6rem;margin-bottom:0.5rem;border:1px solid var(--border);border-radius:10px;">' +
            '  <button id="cloud-btn-login" class="btn btn-primary" style="width:100%;">تسجيل الدخول للسحابة</button>' +
            '</div>' +
            '<div id="cloud-actions-box" style="display:none;">' +
            '  <div id="cloud-auto-box" style="margin:0 0 0.7rem;padding:0.7rem;border:1px dashed #2563eb;border-radius:14px;background:#f8fbff;">' +
            '    <div style="font-weight:800;color:#1d4ed8;">🔄 المزامنة التلقائية <span id="cloud-auto-state" style="font-size:0.8rem;">⚪ متوقفة</span></div>' +
            '    <div style="font-size:0.75rem;color:var(--text-muted);margin:0.25rem 0 0.5rem;">الطلاب والمجموعات والحضور والدفع والغياب والملازم: أي تعديل على هذا الجهاز يظهر على الأجهزة الأخرى تلقائياً.</div>' +
            '    <button id="cloud-btn-auto" class="btn btn-primary" style="width:100%;">تشغيل المزامنة التلقائية</button>' +
            '    <div id="cloud-auto-stats" style="font-size:0.75rem;color:var(--text-muted);margin-top:0.4rem;"></div>' +
            '  </div>' +
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
        $('cloud-btn-auto').onclick = toggleAuto;
        renderAuthState();
        // نحمّل المكتبة في الخلفية لمعرفة حالة تسجيل الدخول المحفوظة
        loadSdk().catch(e => log('تعذّر تحميل مكتبة Firebase (تحقق من الإنترنت): ' + (e && e.message || e), 'err'));
        return true;
    }


    // ---------- المزامنة التلقائية (واجهة + تشغيل) ----------
    let engine = null, statsTimer = null;
    const autoFlag = () => { try { return localStorage.getItem('sync_auto') === '1'; } catch (e) { return false; } };
    const setAutoFlag = (v) => { try { localStorage.setItem('sync_auto', v ? '1' : '0'); } catch (e) { } };

    function refreshUI() {
        if (typeof renderStudents === 'function') { try { renderStudents(); } catch (e) { } }
        if (typeof syncUIWithContext === 'function') { try { syncUIWithContext(); } catch (e) { } }
        if (typeof updateDashboardStats === 'function') { try { updateDashboardStats(); } catch (e) { } }
    }
    function renderAutoState() {
        const st = $('cloud-auto-state'), btn = $('cloud-btn-auto'), sx = $('cloud-auto-stats');
        if (!st || !btn) return;
        const on = !!(engine && engine.isActive());
        st.innerHTML = on ? '<span style="color:#16a34a;">🟢 تعمل</span>' : '<span style="color:var(--text-muted);">⚪ متوقفة</span>';
        btn.textContent = on ? 'إيقاف المزامنة التلقائية' : 'تشغيل المزامنة التلقائية';
        if (sx) {
            if (on) {
                const s = engine.stats;
                sx.textContent = 'رُفع: ' + s.pushed + ' • استُلم: ' + s.pulled + ' • بانتظار الرفع: ' + engine.pendingCount() + ' • تعارضات: ' + s.conflicts + ' • أخطاء: ' + s.errors;
            } else sx.textContent = '';
        }
    }
    function startStatsTimer() {
        clearInterval(statsTimer);
        statsTimer = setInterval(renderAutoState, 2000);
    }
    function describeSummary(sum) {
        const names = { groups: 'مجموعات', students: 'طلاب', attendance: 'حضور', payments: 'دفعات', absenceSessions: 'جلسات غياب', studentHandouts: 'ملازم', cycles: 'دورات' };
        const parts = [];
        Object.keys(sum || {}).forEach(t => {
            const x = sum[t];
            if (x.cloudOnly || x.localOnly || x.conflict) {
                parts.push((names[t] || t) + ': استُلم ' + x.cloudOnly + ' / رُفع ' + x.localOnly + (x.conflict ? ' / تعارض ' + x.conflict : ''));
            }
        });
        return parts.length ? parts.join(' | ') : 'لا فروق بين الجهاز والسحابة';
    }
    async function enableAuto(userInitiated) {
        if (!currentUser) { if (userInitiated) log('سجّل الدخول أولاً', 'err'); return; }
        if (engine && engine.isActive()) return;
        if (userInitiated && !confirm('سيتم تشغيل المزامنة التلقائية:\n• تعديلاتك على هذا الجهاز تظهر على الأجهزة الأخرى فوراً\n• وتعديلات الأجهزة الأخرى تظهر عندك فوراً\n\nأول مرة: يضيف الناقص من السحابة ويرفع الناقص منك، ولا يستبدل سجلاً مختلفاً.\n\nهل حفظت نسخة احتياطية؟ المتابعة؟')) return;
        setBusy(true);
        try {
            const f = await loadSdk();
            engine = createSyncEngine({ fs: f.fs, fsMod: f.fsMod, getDb: () => db, SE: StorageEngine, deviceId, log, onChange: refreshUI, tables: AUTO_TABLES });
            const sum = await engine.start();
            setAutoFlag(true);
            log('تعمل المزامنة التلقائية ✅ — ' + describeSummary(sum), 'ok');
            if (engine.stats.conflicts) log('⚠️ يوجد ' + engine.stats.conflicts + ' سجل مختلف بين جهازك والسحابة؛ بقيت نسختك كما هي ولم تُستبدل.', 'err');
            startStatsTimer();
            refreshUI();
        } catch (e) {
            log('فشل تشغيل المزامنة التلقائية: ' + ((e && e.code) || '') + ' ' + ((e && e.message) || e), 'err');
            try { engine && engine.stop(); } catch (x) { }
            engine = null;
        }
        setBusy(false);
        renderAutoState();
    }
    async function disableAuto() {
        if (engine) { try { await engine.flush(); } catch (e) { } engine.stop(); engine = null; }
        setAutoFlag(false);
        clearInterval(statsTimer);
        renderAutoState();
        log('تم إيقاف المزامنة التلقائية', 'info');
    }
    function toggleAuto() { if (engine && engine.isActive()) disableAuto(); else enableAuto(true); }

    function whenAppReady(cb) {
        let tries = 0;
        const t = setInterval(() => {
            tries++;
            let ready = false;
            try { ready = typeof db !== 'undefined' && typeof StorageEngine !== 'undefined' && !!StorageEngine.db && Array.isArray(db.students); } catch (e) { }
            if (ready) { clearInterval(t); setTimeout(cb, 2500); }
            else if (tries > 80) clearInterval(t);
        }, 500);
    }
    function onAuthChanged() {
        if (currentUser && autoFlag() && !engine) whenAppReady(() => { if (currentUser && !engine) enableAuto(false); });
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
        try { await disableAuto(); } catch (e) { }
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

    window.CloudSync = { _test: { planMerge, stableStringify, stripMeta, cleanForCloud, createSyncEngine, AUTO_TABLES } };
})();
