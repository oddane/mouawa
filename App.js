import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Linking, Platform, Share, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import * as ExpoLinking from 'expo-linking';
import * as SplashScreen from 'expo-splash-screen';
import * as SystemUI from 'expo-system-ui';
import AsyncStorage from '@react-native-async-storage/async-storage';
import mesaHtml from './src/mesaHtml';

SplashScreen.preventAutoHideAsync().catch(() => {});

// Everything the page saves (sign-in session, preferences) lives in AsyncStorage, so it survives restarts
// no matter how the platform WebView treats storage for inline pages.
const STORE_KEY = 'mesa-store-v1';
// The page's origin. Nothing is fetched from it; it only gives the page a stable https origin.
const BASE_URL = 'https://app.mesa.local/';

export default function App() {
  return (
    <SafeAreaProvider>
      <MesaApp />
    </SafeAreaProvider>
  );
}

function MesaApp() {
  const web = useRef(null);
  const storeRef = useRef(null);
  const loaded = useRef(false);
  const pendingLink = useRef(null);
  const [ready, setReady] = useState(false);
  const [mountKey, setMountKey] = useState(0);
  const [theme, setTheme] = useState({ bg: '#FFFFFF', dark: false });

  useEffect(() => {
    AsyncStorage.getItem(STORE_KEY)
      .then((v) => { try { storeRef.current = JSON.parse(v) || {}; } catch { storeRef.current = {}; } })
      .catch(() => { storeRef.current = {}; })
      .finally(() => setReady(true));
  }, []);

  // Email links (confirm account, reset password) come back to the app as mesa://auth#access_token=...
  const sendLink = useCallback((url) => {
    if (!url || !/access_token|error_description/.test(url)) return;
    if (loaded.current && web.current) {
      web.current.injectJavaScript(`window.__mesaDeepLink && window.__mesaDeepLink(${JSON.stringify(url)}); true;`);
    } else {
      pendingLink.current = url;
    }
  }, []);
  useEffect(() => {
    Linking.getInitialURL().then(sendLink).catch(() => {});
    const sub = Linking.addEventListener('url', (e) => sendLink(e.url));
    return () => sub.remove();
  }, [sendLink]);

  // Android back button: let the page close sheets and go back first.
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!web.current) return false;
      web.current.injectJavaScript('window.__mesaBack ? window.__mesaBack() : window.ReactNativeWebView.postMessage(JSON.stringify({t:"exit"})); true;');
      return true;
    });
    return () => sub.remove();
  }, []);

  const remount = useCallback(() => { loaded.current = false; setMountKey((k) => k + 1); }, []);

  const onMessage = useCallback((e) => {
    let m;
    try { m = JSON.parse(e.nativeEvent.data); } catch { return; }
    switch (m.t) {
      case 'store': {
        const s = storeRef.current || {};
        if (m.v == null) delete s[m.k]; else s[m.k] = m.v;
        storeRef.current = s;
        AsyncStorage.setItem(STORE_KEY, JSON.stringify(s)).catch(() => {});
        break;
      }
      case 'reload':
        remount();
        break;
      case 'haptic': {
        const ms = Array.isArray(m.p) ? m.p[0] : m.p;
        if (!ms) break;
        const style = ms >= 25 ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light;
        Haptics.impactAsync(style).catch(() => {});
        break;
      }
      case 'share': {
        const text = [m.text, m.url].filter(Boolean).join(' ');
        Share.share(Platform.OS === 'ios' ? { url: m.url || undefined, message: m.text || m.title || undefined } : { message: text, title: m.title || undefined }).catch(() => {});
        break;
      }
      case 'open':
        if (/^(https?|mailto|tel|sms):/i.test(m.url || '')) Linking.openURL(m.url).catch(() => {});
        break;
      case 'theme':
        if (m.bg) {
          setTheme({ bg: m.bg, dark: !!m.dark });
          SystemUI.setBackgroundColorAsync(m.bg).catch(() => {});
        }
        break;
      case 'exit':
        if (Platform.OS === 'android') BackHandler.exitApp();
        break;
      default:
    }
  }, [remount]);

  // The saved session and settings are written straight into the page, so they are there before any script runs.
  const html = useMemo(() => {
    if (!ready) return '';
    const safe = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
    const boot = `<script>window.MESA_STORE=${safe(storeRef.current || {})};window.MESA_REDIRECT=${safe(ExpoLinking.createURL('auth'))};window.MESA_PLATFORM=${safe(Platform.OS)};</script>`;
    return mesaHtml.replace('<head>', () => '<head>' + boot);
    // Rebuilt on every remount so the page gets the latest saved session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, mountKey]);

  const onLoadEnd = useCallback(() => {
    loaded.current = true;
    SplashScreen.hideAsync().catch(() => {});
    if (pendingLink.current) {
      const u = pendingLink.current;
      pendingLink.current = null;
      setTimeout(() => sendLink(u), 400);
    }
  }, [sendLink]);

  const onShouldStart = useCallback((req) => {
    const u = req.url || '';
    if (u.startsWith(BASE_URL) || u === 'about:blank' || u.startsWith('about:') || u.startsWith('data:') || u.startsWith('blob:')) return true;
    if (req.isTopFrame === false) return true;
    if (/^(https?|mailto|tel|sms):/i.test(u)) Linking.openURL(u).catch(() => {});
    return false;
  }, []);

  if (!ready) return <View style={[styles.fill, { backgroundColor: theme.bg }]} />;

  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: theme.bg }]} edges={['top', 'bottom', 'left', 'right']}>
      <StatusBar style={theme.dark ? 'light' : 'dark'} />
      <WebView
        key={mountKey}
        ref={web}
        source={{ html, baseUrl: BASE_URL }}
        originWhitelist={['*']}
        onMessage={onMessage}
        onLoadEnd={onLoadEnd}
        onShouldStartLoadWithRequest={onShouldStart}
        onContentProcessDidTerminate={remount}
        onRenderProcessGone={remount}
        style={[styles.fill, { backgroundColor: theme.bg }]}
        containerStyle={{ backgroundColor: theme.bg }}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        allowsBackForwardNavigationGestures={false}
        setSupportMultipleWindows={false}
        keyboardDisplayRequiresUserAction={false}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        hideKeyboardAccessoryView={false}
        overScrollMode="never"
        bounces={false}
        textZoom={100}
        pullToRefreshEnabled={false}
        allowsLinkPreview={false}
        webviewDebuggingEnabled={__DEV__}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
