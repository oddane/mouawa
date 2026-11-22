
/* ============ Native app: Supabase accounts (real email confirmation, reset links) ============ */
if (window.MOUAWA_NATIVE) {
  const sb = window.mouawaSB || null, NS = window.mouawaStore;
  const REDIRECT = () => window.MOUAWA_REDIRECT || 'mouawa://auth';
  S.native = {out:false};
  const until = (fn, ms = 15000) => new Promise(res => { const t0 = Date.now(); const k = () => (fn() || Date.now() - t0 > ms) ? res() : setTimeout(k, 80); k(); });

  boot = async function(){
    render();
    if (!sb) { S.mode = 'offline'; render(); return; }
    const c = window.claude;
    [db, userCap, assets] = await Promise.all([c.use('db'), c.use('user'), c.use('assets')]);
    let m = null; try { m = await userCap.me(); } catch (e) { m = null; }
    S.mode = 'live';
    if (m) { S.person = m.id; S.myName = m.name || ''; S.native.email = m.email; subscribe(); nativeAfterLogin(); }
    else {
      S.person = null; S.native.out = true; S.sessionLoaded = true; S.loaded.posts = true;
      db.collection('profiles').onSnapshot(snap => { const mm = {}; snap.docs.forEach(d => { mm[d.id] = {id:d.id, ...d.data()}; }); S.profiles = mm; S.loaded.profiles = true; bump(); },
        () => { S.loaded.profiles = true; render(); });
    }
    const fl = NS.getItem('mouawa-flash'); if (fl) { NS.removeItem('mouawa-flash'); setTimeout(() => toast(fl), 600); }
    render(); roomSetup();
    if (window.mouawaSendTheme) setTimeout(window.mouawaSendTheme, 100);
  };

  async function nativeAfterLogin(){
    await until(() => S.loaded.profiles && S.sessionLoaded);
    let u = null; try { u = (await sb.auth.getUser()).data.user; } catch (e) {}
    const fresh = NS.getItem('mouawa-fresh'), want = NS.getItem('mouawa-want');
    NS.removeItem('mouawa-fresh'); NS.removeItem('mouawa-want');
    if (fresh) { const lo = {}; for (const p of ownedAccounts()) lo[p.id] = 0; if (Object.keys(lo).length) await saveSession({loggedOut:lo}); pickAccount(); }
    if (!ownedAccounts().length) {
      if (u && u.user_metadata && u.user_metadata.pending) await finishPending(u);
      else { S.auth = freshAuth('signup'); S.auth.email = (u && u.email) || ''; S.auth.name = S.myName || ''; S.creating = true; render(); }
    }
    if (want) { const p = byHandle(want); if (p && isOwned(p.id) && p.id !== S.uid) switchAccount(p.id, true); }
    if (NS.getItem('mouawa-recovery')) { NS.removeItem('mouawa-recovery'); openModal({type:'nv-newpw'}); }
    for (const p of ownedAccounts()) sb.rpc('claim_handle', {h:p.handle}).then(() => {}, () => {});
  }
  async function finishPending(u){
    const pd = u.user_metadata.pending || {}, d = {...(pd.d || {})}, t = now();
    if (!d.handle) return;
    let h = d.handle; if (byHandle(h) || RESERVED.includes(h)) h = (h.slice(0, 12) + Math.floor(Math.random() * 900 + 100)).slice(0, 15);
    d.handle = h; d.joined = t; d.following = d.following || {};
    if (S.profiles.mesa) d.following.mesa = t;
    const acct = S.person;
    await run(async () => {
      await putProfile(acct, d);
      if (u.email) await setEmail(acct, u.email);
      await saveSession({accounts:{[acct]:t}, active:acct});
      await sb.rpc('claim_handle', {h});
      await sb.auth.updateUser({data:{pending:null}});
      await switchAccount(acct, true);
      if (pd.x) go('switch');
      toast(h !== pd.d.handle ? `@${pd.d.handle} was taken while you confirmed, so you’re @${h}. You can change it in Settings.` : (d.pro && d.pro.verify && d.pro.verify.status === 'pending' ? `Welcome, @${h}. Your checkmark request is in review.` : `Welcome to Mouawa, @${h}`));
    });
  }

  /* Sign up: first account on this phone creates a Supabase user and sends a confirmation email. */
  const _auCreateN = auCreate;
  auCreate = async function(){
    if (S.person) return _auCreateN();
    const a = S.auth, t = now(), org = isOrgType(a.type);
    a.x = (a.x || '').trim().replace(/^@/, '');
    if (a.x && !/^[A-Za-z0-9_]{1,15}$/.test(a.x)) return auErr('That X username doesn’t look right.');
    if (byHandle(a.handle)) { a.step = 2; a.err = `@${a.handle} was just taken. Pick another.`; return render(); }
    const d = {handle:a.handle, name:a.name, bio:'', human:!org, color:AV_COLORS[Math.floor(Math.random() * AV_COLORS.length)], joined:t, following:{}, acctType:a.type};
    for (const [uid, v] of Object.entries(a.follow)) if (v && S.profiles[uid]) d.following[uid] = t;
    const topics = Object.keys(a.topics).filter(k => a.topics[k]); if (topics.length) d.interests = topics;
    if (a.x) d.xHandle = a.x;
    if (a.type !== 'personal') {
      d.pro = {type:a.type, category:(a.cat || 'Digital creator').slice(0, 40), contact:{website:a.web || '', email:'', phone:'', location:'', hours:''}, showCategory:true, since:t, govLevel:a.level || ''};
      if (org) d.pro.verify = a.verify ? {status:'pending', at:t, domainMatch:domainMatch(a.email, a.web), site:domainOf(a.web)} : {status:'none', at:t};
    }
    const btn = $('#su-form button[type=submit]'); if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
    const reset = () => { const b = $('#su-form button[type=submit]'); if (b) { b.disabled = false; b.textContent = org ? 'Create organization account' : 'Create account'; } };
    let r; try { r = await sb.auth.signUp({email:a.email, password:a.pw, options:{emailRedirectTo:REDIRECT(), data:{name:a.name, pending:{d, x:a.x}}}}); }
    catch (e) { reset(); return auErr('We couldn’t reach Mouawa. Check your connection and try again.'); }
    if (r.error) {
      reset(); const m = r.error.message || '';
      if (/registered|exists/i.test(m)) { a.step = 2; a.err = 'That email already has an account. Log in instead.'; return render(); }
      if (/password/i.test(m)) { a.step = 2; a.err = m; return render(); }
      if (/rate|security purposes/i.test(m)) return auErr('Too many tries. Wait a minute, then try again.');
      return auErr(m || 'Sign-up didn’t work. Try again.');
    }
    if (r.data && r.data.user && Array.isArray(r.data.user.identities) && !r.data.user.identities.length) { reset(); a.step = 2; a.err = 'That email already has an account. Log in instead.'; return render(); }
    if (r.data && r.data.session) { NS.setItem('mouawa-fresh', '1'); window.mouawaReload(); return; }
    a.screen = 'verify'; a.sentTo = a.email; S.creating = false; render(); window.scrollTo(0, 0);
  };
  function verifyHTML(){
    const a = S.auth;
    return `<div class="su"><div class="su-card">
      <div class="su-top"><button type="button" class="ibtn" data-act="au-home" aria-label="Back">${ic('back', 20, 2.2)}</button><span class="logo-mark">${logo(26)}</span><span></span></div>
      <div class="su-body nv-center"><span class="nv-badge">${ic('mail', 30, 2)}</span><h1 class="su-h">Check your email</h1>
        <p class="su-p">We sent a link to <b>${esc(a.sentTo || '')}</b>. Open it on this phone to confirm and finish creating <b>@${esc(a.handle)}</b>.</p>
        <p class="hint">Don’t see it within a minute? Check spam or promotions, or send it again.</p></div>
      <div class="su-foot"><button class="btn btn-acc btn-lg" data-act="nv-confirmed">I’ve confirmed, log in</button><button class="btn btn-line btn-lg" data-act="nv-resend">Send the link again</button><button class="lnk" data-act="nv-change">Use a different email</button></div>
    </div></div>`;
  }
  function offlineHTML(){
    return `<div class="su"><div class="su-card"><div class="su-body nv-center" style="padding-top:12vh"><span class="nv-badge">${ic('globe', 30, 2)}</span><h1 class="su-h">You’re offline</h1><p class="su-p">Mouawa needs an internet connection. Check Wi-Fi or mobile data, then try again.</p></div><div class="su-foot"><button class="btn btn-acc btn-lg" data-act="nv-retry">Try again</button></div></div></div>`;
  }
  const _viewOnboardN = viewOnboard;
  viewOnboard = function(){ if (S.mode === 'offline') return offlineHTML(); if (S.auth.screen === 'verify' && !S.creating) return verifyHTML(); return _viewOnboardN(); };

  /* Log in: email goes straight to Supabase; usernames go through the login function. */
  const _submitLoginN = submitLogin;
  submitLogin = async function(){
    if (S.person) return _submitLoginN();
    const u = $('#lg-user'), v = ((u && u.value) || '').trim(), pw = ($('#lg-pw') || {}).value || '';
    const e = $('#lg-err'), err = (m, html) => { if (e) { if (html) e.innerHTML = m; else e.textContent = m; } };
    if (!v || !pw) return err('Enter your email or username, and your password.');
    const b = $('#login-form button[type=submit]'); if (b) { b.disabled = true; b.textContent = 'Logging in…'; }
    const done = () => { const b2 = $('#login-form button[type=submit]'); if (b2) { b2.disabled = false; b2.textContent = 'Log in'; } };
    const unconfirmed = em => { S.auth.sentTo = em || ''; err(`Confirm your email first. Tap the link we sent when you signed up.${em ? ` <button type="button" class="lnk" data-act="nv-resend">Send it again</button>` : ''}`, true); };
    try {
      if (v.includes('@') && !v.startsWith('@')) {
        if (!EMAIL_RE.test(v)) { done(); return err('That email doesn’t look right.'); }
        const r = await sb.auth.signInWithPassword({email:normEmail(v), password:pw});
        if (r.error) { done(); return /confirm/i.test(r.error.message) ? unconfirmed(normEmail(v)) : err(/rate|many/i.test(r.error.message) ? 'Too many tries. Wait a minute, then try again.' : 'That email and password don’t match.'); }
      } else {
        const h = v.replace(/^@/, '').toLowerCase();
        const r = await sb.functions.invoke('login', {body:{handle:h, password:pw}});
        let code = 'invalid_credentials'; if (r.error) { try { code = (await r.error.context.json()).error || code; } catch (x) {} }
        if (r.error || !r.data || !r.data.access_token) { done(); return code === 'email_not_confirmed' ? unconfirmed('') : err('That username and password don’t match.'); }
        const s = await sb.auth.setSession({access_token:r.data.access_token, refresh_token:r.data.refresh_token});
        if (s.error) { done(); return err('Logging in didn’t work. Try again.'); }
        NS.setItem('mouawa-want', h);
      }
      NS.setItem('mouawa-fresh', '1'); window.mouawaReload();
    } catch (x) { done(); err('We couldn’t reach Mouawa. Check your connection and try again.'); }
  };

  /* Log out: leaving the last account on the phone signs out of Supabase. */
  const _logOutN = logOut;
  logOut = async function(id){ const others = loggedIn().filter(p => p.id !== id); if (others.length) return _logOutN(id); return nativeSignOut(); };
  async function nativeSignOut(){ S.native.out = true; try { await sb.auth.signOut(); } catch (e) {} NS.setItem('mouawa-flash', 'You’re logged out'); window.mouawaReload(); }

  /* Keep username login working when a handle changes. */
  const _patchProfileN = patchProfile;
  patchProfile = async function(id, d){ const r = await _patchProfileN(id, d); if (d && d.handle && isOwned(id) && sb) sb.rpc('claim_handle', {h:d.handle}).then(() => {}, () => {}); return r; };
  const _putProfileN = putProfile;
  putProfile = async function(id, d){ const r = await _putProfileN(id, d); if (d && d.handle && S.person && sb) sb.rpc('claim_handle', {h:d.handle}).then(() => {}, () => {}); return r; };

  /* Changing the main account's email also changes the login email (Supabase sends a confirmation). */
  const _emailFormN = EXTRA_FORMS['email-form'];
  EXTRA_FORMS['email-form'] = async () => {
    const v = normEmail(($('#em-new') || {}).value);
    await _emailFormN();
    if (S.uid === S.person && EMAIL_RE.test(v) && !S.modal) {
      const r = await sb.auth.updateUser({email:v}, {emailRedirectTo:REDIRECT()});
      toast(r.error ? (r.error.message || 'Couldn’t change your login email') : `Confirm the change from the link sent to ${v}`);
    }
  };

  Object.assign(A, {
    'logout-all': () => nativeSignOut(),
    'nv-retry': () => window.mouawaReload(),
    'nv-confirmed': () => { S.showLogin = true; S.loginPrefill = S.auth.sentTo || ''; S.auth.screen = 'welcome'; S.creating = false; render(); setTimeout(() => $('#lg-pw')?.focus(), 60); },
    'nv-change': () => { S.auth.screen = 'signup'; S.auth.step = 2; S.creating = true; render(); },
    'nv-resend': async () => {
      const em = S.auth.sentTo || normEmail(($('#lg-user') || {}).value);
      if (!EMAIL_RE.test(em || '')) { toast('Enter your email first'); return; }
      const r = await sb.auth.resend({type:'signup', email:em, options:{emailRedirectTo:REDIRECT()}});
      toast(r.error ? (/rate|security/i.test(r.error.message) ? 'Wait a minute before sending another link.' : r.error.message) : `Link sent to ${em}`);
    },
    'pw-forgot': async () => {
      if (S.person) { let v = (($('#lg-user') || {}).value || '').trim(); if (v.includes('@') && !v.startsWith('@')) { try { const id = await emailOwner(v); v = id && S.profiles[id] ? S.profiles[id].handle : ''; } catch (e) { v = ''; } } openModal({type:'pw-forgot', handle:v.replace(/^@/, '').toLowerCase()}); return; }
      const v = (($('#lg-user') || {}).value || '').trim(); openModal({type:'nv-reset', email:EMAIL_RE.test(v) ? normEmail(v) : ''});
    }
  });
  EXTRA_MODALS['nv-reset'] = m => m.sent
    ? sheet('Check your email', `<div class="sheet-b"><p style="margin:0">If an account uses <b>${esc(m.email)}</b>, we sent it a link to reset the password. Open it on this phone.</p><button class="btn btn-acc btn-lg" data-act="close">Done</button></div>`, {sm:true})
    : `<form id="nv-reset-form">${sheet('Reset your password', `<div class="sheet-b"><p style="margin:0" class="muted">Enter the email on your account and we’ll send you a link to choose a new password.</p>
      <div class="field"><label for="nr-email">Email</label><input id="nr-email" class="input" type="email" inputmode="email" autocapitalize="none" spellcheck="false" maxlength="120" autocomplete="email" value="${esc(m.email || '')}"></div>
      <p class="err" id="nr-err" role="alert"></p><button class="btn btn-acc btn-lg" type="submit">Send reset link</button></div>`, {sm:true})}</form>`;
  EXTRA_FORMS['nv-reset-form'] = async () => {
    const em = normEmail($('#nr-email').value), err = m => { $('#nr-err').textContent = m; };
    if (!EMAIL_RE.test(em)) return err('Enter an email like you@example.com.');
    const r = await sb.auth.resetPasswordForEmail(em, {redirectTo:REDIRECT()});
    if (r.error && /rate|security/i.test(r.error.message)) return err('Wait a minute before asking for another link.');
    openModal({type:'nv-reset', email:em, sent:true});
  };
  EXTRA_MODALS['nv-newpw'] = () => `<form id="nv-newpw-form">${sheet('Choose a new password', `<div class="sheet-b">
    <div class="field"><label for="np-pw">New password</label><div class="pw-wrap"><input id="np-pw" class="input" type="password" autocomplete="new-password" maxlength="128"><button type="button" class="lnk pw-tg" data-act="pw-show" data-for="np-pw">Show</button></div><span class="hint">At least 8 characters. A short phrase works well.</span></div>
    <p class="err" id="np-err" role="alert"></p><button class="btn btn-acc btn-lg" type="submit">Save password</button></div>`, {sm:true})}</form>`;
  EXTRA_FORMS['nv-newpw-form'] = async () => {
    const pw = $('#np-pw').value, err = m => { $('#np-err').textContent = m; };
    if (pw.length < 8) return err('Passwords need at least 8 characters.');
    const r = await sb.auth.updateUser({password:pw});
    if (r.error) return err(r.error.message || 'That didn’t work. Try again.');
    closeModal(); toast('Password updated');
  };

  /* Android back button */
  window.__mouawaBack = () => {
    if (S.modal) { closeModal(); return; }
    if (S.history && S.history.length) { A.back(); return; }
    if (me() && S.view !== 'home') { go('home'); return; }
    if (S.creating && S.auth.step > 1) { A['au-back'](); return; }
    if (S.creating || S.showLogin || S.auth.screen === 'verify') { A['au-home'](); return; }
    if (window.mouawaPost) window.mouawaPost({t:'exit'});
  };
}
