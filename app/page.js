'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import {
  CalendarDays,
  Camera,
  CheckCircle2,
  Loader2,
  LogOut,
  QrCode,
  RefreshCw,
  Search,
  ShieldCheck,
  UserCheck,
  Users,
  XCircle,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';

const ALLOWED_ROLES = new Set(['admin', 'agent', 'driver', 'motorista']);
const EVENT_DATES = ['2026-06-20', '2026-06-21'];

function normalizeLogin(value) {
  const trimmed = value.trim();
  return trimmed.includes('@') ? trimmed : `${trimmed}@nawabus.com`;
}

function parseScannedValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const parsed = JSON.parse(raw);
    return parsed.ticket_id || parsed.ticketId || parsed.id || parsed.reference || parsed.reference_number || raw;
  } catch {}

  try {
    const url = new URL(raw);
    const parts = url.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || raw;
  } catch {}

  return raw;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function escapeIlikeValue(value) {
  return String(value || '').replace(/[%_]/g, '\\$&');
}

function luandaRange(dateValue) {
  const start = new Date(`${dateValue}T00:00:00+01:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function formatLuandaDateTime(value) {
  return new Intl.DateTimeFormat('pt-PT', {
    timeZone: 'Africa/Luanda',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatLuandaTime(value) {
  return new Intl.DateTimeFormat('pt-PT', {
    timeZone: 'Africa/Luanda',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function getPassengerName(ticket) {
  const companion = Array.isArray(ticket.ticket_companions)
    ? ticket.ticket_companions[0]
    : ticket.ticket_companions;
  const companionName = companion?.name?.trim();
  if (companionName) return companionName;

  const bookingCompanionName = ticket.booking_companion?.name?.trim();
  if (bookingCompanionName) return bookingCompanionName;

  const profile = ticket.profiles;
  const fullName = `${profile?.first_name || ''} ${profile?.last_name || ''}`.trim();
  return fullName || 'Passageiro';
}

function getPassengerPhone(ticket) {
  const companion = Array.isArray(ticket.ticket_companions)
    ? ticket.ticket_companions[0]
    : ticket.ticket_companions;
  return companion?.phone || ticket.booking_companion?.phone || ticket.profiles?.phone_number || '';
}

function getBookingCompanion(bookingDetails, ticket) {
  const trips = [
    bookingDetails?.outbound_trip,
    bookingDetails?.return_trip,
  ].filter(Boolean);
  const bookingTrip = trips.find((trip) => trip.trip_id === ticket?.trip_id);
  const companions = bookingTrip?.companions || {};
  return companions[String(ticket?.seat_number)] || companions[Number(ticket?.seat_number)] || null;
}

function applyBookingCompanions(tickets, bookingDetails) {
  return (tickets || []).map((ticket) => ({
    ...ticket,
    booking_companion: getBookingCompanion(bookingDetails, ticket),
  }));
}

function routeLabel(trip) {
  return `${trip?.routes?.origin_city || '-'} -> ${trip?.routes?.destination_city || '-'}`;
}

function isBoarded(ticket, boardedIds) {
  return ticket.status === 'used' || boardedIds.has(ticket.id);
}

export default function ScannerApp() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(true);

  const [selectedDate, setSelectedDate] = useState(EVENT_DATES[0]);
  const [statsLoading, setStatsLoading] = useState(false);
  const [stats, setStats] = useState([]);
  const [showDashboard, setShowDashboard] = useState(false);
  const [statsLoaded, setStatsLoaded] = useState(false);

  const [manualInput, setManualInput] = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [scanError, setScanError] = useState('');
  const [scanMessage, setScanMessage] = useState('');
  const [scanResult, setScanResult] = useState(null);

  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [cameraStatus, setCameraStatus] = useState('Pronto para ler QR');
  const [isScanning, setIsScanning] = useState(false);
  const videoRef = useRef(null);
  const scanResultRef = useRef(null);
  const streamRef = useRef(null);
  const readerRef = useRef(null);
  const controlsRef = useRef(null);
  const processingRef = useRef(false);
  const lastScanRef = useRef({ value: '', at: 0 });

  useEffect(() => {
    const init = async () => {
      const { data } = await supabase.auth.getSession();
      setSession(data.session);
      if (data.session?.user) await loadProfile(data.session.user.id);
      setAuthLoading(false);
    };

    const { data: listener } = supabase.auth.onAuthStateChange(async (_event, nextSession) => {
      setSession(nextSession);
      if (nextSession?.user) {
        await loadProfile(nextSession.user.id);
      } else {
        setProfile(null);
      }
    });

    init();
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!cameraOpen) {
      stopCamera();
      return;
    }
    startCamera();
    return () => {
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOpen]);

  async function loadProfile(userId) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, role, first_name, last_name, phone_number')
      .eq('id', userId)
      .single();

    if (error || !data || !ALLOWED_ROLES.has(data.role)) {
      setAuthError('Acesso negado. Use uma conta admin, agente ou motorista.');
      setProfile(null);
      await supabase.auth.signOut();
      return;
    }

    setAuthError('');
    setProfile(data);
  }

  async function handleLogin(event) {
    event.preventDefault();
    setAuthError('');
    setAuthLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email: normalizeLogin(loginId),
      password,
    });

    if (error) setAuthError(error.message);
    setAuthLoading(false);
  }

  async function signOut() {
    await stopCamera();
    await supabase.auth.signOut();
    setScanResult(null);
  }

  async function loadStats() {
    setStatsLoading(true);
    try {
      const range = luandaRange(selectedDate);
      const { data: trips, error: tripsError } = await supabase
        .from('trips')
        .select('id, departure_time, arrival_time, routes(origin_city, destination_city)')
        .gte('departure_time', range.start)
        .lt('departure_time', range.end)
        .order('departure_time', { ascending: true });

      if (tripsError) throw tripsError;
      const tripIds = (trips || []).map((trip) => trip.id);
      if (tripIds.length === 0) {
        setStats([]);
        return;
      }

      const { data: tickets, error: ticketsError } = await supabase
        .from('tickets')
        .select('id, trip_id, status, payment_status')
        .in('trip_id', tripIds)
        .eq('payment_status', 'paid')
        .in('status', ['active', 'used']);

      if (ticketsError) throw ticketsError;

      const ticketIds = (tickets || []).map((ticket) => ticket.id);
      const { data: scans, error: scansError } = ticketIds.length
        ? await supabase
            .from('ticket_scans')
            .select('ticket_id')
            .in('ticket_id', ticketIds)
            .eq('scan_type', 'boarding')
        : { data: [], error: null };

      if (scansError) throw scansError;

      const tripMap = new Map((trips || []).map((trip) => [trip.id, trip]));
      const boardedIds = new Set((scans || []).map((scan) => scan.ticket_id));
      const groups = new Map();

      for (const ticket of tickets || []) {
        const trip = tripMap.get(ticket.trip_id);
        if (!trip) continue;
        const time = formatLuandaTime(trip.departure_time);
        const route = routeLabel(trip);
        const key = `${time}|${route}`;
        if (!groups.has(key)) {
          groups.set(key, { time, route, total: 0, scanned: 0, confirmed: 0, boarded: 0 });
        }
        const group = groups.get(key);
        group.total += 1;
        if (boardedIds.has(ticket.id)) group.scanned += 1;
        if (ticket.status === 'used') group.confirmed += 1;
        if (ticket.status === 'used' || boardedIds.has(ticket.id)) group.boarded += 1;
      }

      setStats(
        [...groups.values()]
          .map((group) => ({ ...group, pending: group.total - group.boarded }))
          .sort((a, b) => a.time.localeCompare(b.time) || a.route.localeCompare(b.route))
      );
      setStatsLoaded(true);
    } catch (error) {
      setScanError(`Erro ao carregar dashboard: ${error.message}`);
    } finally {
      setStatsLoading(false);
    }
  }

  async function stopCamera() {
    try {
      controlsRef.current?.stop();
    } catch {}
    controlsRef.current = null;
    readerRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setIsScanning(false);
  }

  async function startCamera() {
    try {
      setCameraError('');
      setCameraStatus('A ligar camera...');
      setIsScanning(true);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 640, max: 960 },
          height: { ideal: 480, max: 720 },
          focusMode: { ideal: 'continuous' },
        },
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute('playsinline', 'true');
        await videoRef.current.play();
      }

      const reader = new BrowserMultiFormatReader(null, 300);
      readerRef.current = reader;
      setCameraStatus('A ler QR...');

      const controls = await reader.decodeFromVideoElement(videoRef.current, (result) => {
        if (!result) return;
        const text = parseScannedValue(result.getText());
        const now = Date.now();
        const isDuplicate =
          lastScanRef.current.value === text && now - lastScanRef.current.at < 3500;
        if (!text || processingRef.current || isDuplicate) return;

        processingRef.current = true;
        lastScanRef.current = { value: text, at: now };
        setCameraStatus('QR lido');
        if (navigator.vibrate) navigator.vibrate(120);
        stopCamera();
        setCameraOpen(false);
        lookupTicket(text, { clearExistingResult: false }).finally(() => {
          setTimeout(() => {
            processingRef.current = false;
          }, 1800);
        });
      });
      controlsRef.current = controls;
    } catch (error) {
      processingRef.current = false;
      setIsScanning(false);
      setCameraError(
        error.name === 'NotAllowedError'
          ? 'Permissao da camera negada. Abra as permissoes do navegador e tente novamente.'
          : `Erro ao abrir camera: ${error.message}`
      );
    }
  }

  async function lookupTicket(inputValue = manualInput, options = {}) {
    const { clearExistingResult = true } = options;
    const value = parseScannedValue(inputValue);
    if (!value) return;

    setLookupLoading(true);
    setScanError('');
    setScanMessage('');
    if (clearExistingResult) setScanResult(null);

    try {
      const select = `
        id,
        ticket_number,
        payment_reference,
        trip_id,
        passenger_id,
        seat_number,
        status,
        payment_status,
        ticket_companions(name, phone),
        profiles!fk_passenger_id(first_name, last_name, phone_number),
        trips(id, departure_time, arrival_time, routes(origin_city, destination_city))
      `;

      let query = supabase.from('tickets').select(select);
      if (isUuid(value)) {
        query = query.eq('id', value);
      } else {
        const pattern = `%${escapeIlikeValue(value)}%`;
        query = query.or(`ticket_number.ilike.${pattern},payment_reference.ilike.${pattern}`);
      }

      const { data: firstRows, error: firstError } = await query.limit(1);
      if (firstError) throw firstError;
      const firstTicket = firstRows?.[0];
      if (!firstTicket) {
        setScanError('Bilhete nao encontrado.');
        return;
      }
      if (firstTicket.payment_status !== 'paid') {
        setScanError(`Pagamento nao confirmado. Estado: ${firstTicket.payment_status}`);
        return;
      }

      const { data: groupTickets, error: groupError } = await supabase
        .from('tickets')
        .select(select)
        .eq('payment_reference', firstTicket.payment_reference)
        .eq('trip_id', firstTicket.trip_id)
        .eq('payment_status', 'paid')
        .in('status', ['active', 'used'])
        .order('seat_number', { ascending: true });

      if (groupError) throw groupError;
      const { data: payment, error: paymentError } = firstTicket.payment_reference
        ? await supabase
            .from('payment_transactions')
            .select('gateway_response')
            .eq('transaction_id', firstTicket.payment_reference)
            .maybeSingle()
        : { data: null, error: null };

      if (paymentError) throw paymentError;

      const ticketsWithCompanions = applyBookingCompanions(
        groupTickets || [],
        payment?.gateway_response?.booking_details
      );
      const ids = (groupTickets || []).map((ticket) => ticket.id);
      const { data: scans, error: scansError } = ids.length
        ? await supabase
            .from('ticket_scans')
            .select('ticket_id, scanned_at, driver_id')
            .in('ticket_id', ids)
            .eq('scan_type', 'boarding')
        : { data: [], error: null };

      if (scansError) throw scansError;
      const boardedIds = new Set((scans || []).map((scan) => scan.ticket_id));

      setScanResult({
        scannedTicketId: firstTicket.id,
        reference: firstTicket.payment_reference,
        trip: firstTicket.trips,
        tickets: ticketsWithCompanions,
        scans: scans || [],
        boardedIds,
      });
      setManualInput('');
      setTimeout(() => {
        scanResultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 80);
    } catch (error) {
      setScanError(`Erro ao validar bilhete: ${error.message}`);
    } finally {
      setLookupLoading(false);
    }
  }

  async function markBoarded(ticketIds) {
    if (!profile || !ticketIds.length) return;
    setLookupLoading(true);
    setScanError('');
    setScanMessage('');

    try {
      const unboardedIds = ticketIds.filter((id) => !scanResult.boardedIds.has(id));
      if (unboardedIds.length === 0) {
        setScanMessage('Todos os passageiros selecionados ja estavam embarcados.');
        return;
      }

      const rows = unboardedIds.map((ticketId) => ({
        ticket_id: ticketId,
        driver_id: profile.id,
        scan_type: 'boarding',
        scanned_at: new Date().toISOString(),
      }));

      const { error: scanError } = await supabase.from('ticket_scans').insert(rows);
      if (scanError) throw scanError;

      const { error: updateError } = await supabase
        .from('tickets')
        .update({ status: 'used' })
        .in('id', unboardedIds);

      if (updateError) {
        setScanMessage('Embarque registado. Aviso: nao foi possivel mudar o estado do bilhete para used.');
      } else {
        setScanMessage(`${unboardedIds.length} passageiro(s) marcado(s) como embarcado(s).`);
      }

      const nextBoardedIds = new Set([...scanResult.boardedIds, ...unboardedIds]);
      setScanResult({
        ...scanResult,
        boardedIds: nextBoardedIds,
        tickets: scanResult.tickets.map((ticket) => (
          unboardedIds.includes(ticket.id) ? { ...ticket, status: 'used' } : ticket
        )),
      });
      if (statsLoaded) loadStats();
    } catch (error) {
      setScanError(`Erro ao confirmar embarque: ${error.message}`);
    } finally {
      setLookupLoading(false);
    }
  }

  const totals = useMemo(() => {
    return stats.reduce(
      (acc, group) => ({
        total: acc.total + group.total,
        scanned: acc.scanned + group.scanned,
        confirmed: acc.confirmed + group.confirmed,
        boarded: acc.boarded + group.boarded,
        pending: acc.pending + group.pending,
      }),
      { total: 0, scanned: 0, confirmed: 0, boarded: 0, pending: 0 }
    );
  }, [stats]);

  if (authLoading) {
    return (
      <main className="login">
        <div className="card login-card">
          <Loader2 size={26} />
          <p className="muted">A carregar scanner...</p>
        </div>
      </main>
    );
  }

  if (!session || !profile) {
    return (
      <main className="login">
        <section className="card login-card">
          <div className="brand" style={{ marginBottom: 18 }}>
            <div className="brand-mark"><QrCode size={24} /></div>
            <div>
              <p className="eyebrow">NawaBus</p>
              <h1>Scanner de embarque</h1>
              <p className="muted">Admin, agente ou motorista.</p>
            </div>
          </div>
          <form className="grid" onSubmit={handleLogin}>
            <div className="field">
              <label>Telefone ou email</label>
              <input className="input" value={loginId} onChange={(event) => setLoginId(event.target.value)} placeholder="9xx ou email" />
            </div>
            <div className="field">
              <label>Senha</label>
              <input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </div>
            {authError && <div className="notice notice-error">{authError}</div>}
            <button className="btn btn-primary" disabled={authLoading}>
              {authLoading ? 'A entrar...' : 'Entrar'}
            </button>
          </form>
        </section>
      </main>
    );
  }

  const displayName = `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || profile.role;
  const resetStatsForDate = (date) => {
    setSelectedDate(date);
    setStats([]);
    setStatsLoaded(false);
  };
  const openDashboard = () => {
    setShowDashboard((current) => {
      const next = !current;
      if (next && !statsLoaded && !statsLoading) {
        loadStats();
      }
      return next;
    });
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><QrCode size={24} /></div>
          <div>
            <p className="eyebrow">NawaBus Scanner</p>
            <h1>Embarque Mangais</h1>
            <p className="muted">Logado como {displayName} - {profile.role}</p>
          </div>
        </div>
        <div className="actions">
          <button className="btn btn-ghost" onClick={loadStats} disabled={statsLoading}>
            <RefreshCw size={18} /> Atualizar
          </button>
          <button className="btn btn-danger" onClick={signOut}>
            <LogOut size={18} /> Sair
          </button>
        </div>
      </header>

      {scanError && <div className="notice notice-error">{scanError}</div>}
      {scanMessage && <div className="notice notice-ok">{scanMessage}</div>}

      <section className="grid scanner-layout">
        <div className="grid">
          <div className="card scanner-home-card">
            <div className="card-header">
              <div>
                <p className="eyebrow">Operacao</p>
                <h2>Escanear bilhete</h2>
                <p className="muted">Leia o QR do PDF ou digite a referencia. Depois confirme apenas quem entrou no autocarro.</p>
              </div>
              <ShieldCheck color="var(--lime)" />
            </div>
            <div className="actions mobile-sticky-action" style={{ marginTop: 16 }}>
              <button className="btn btn-primary scan-main-button" onClick={() => setCameraOpen(true)}>
                <Camera size={19} /> Abrir camera
              </button>
            </div>
            <div className="grid manual-search" style={{ marginTop: 14 }}>
              <input
                className="input"
                value={manualInput}
                onChange={(event) => setManualInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') lookupTicket();
                }}
                placeholder="ID do bilhete, numero TKT ou referencia"
              />
              <button className="btn btn-lime" onClick={() => lookupTicket()} disabled={lookupLoading}>
                {lookupLoading ? <Loader2 size={18} /> : <Search size={18} />} Procurar
              </button>
            </div>
          </div>

          {cameraOpen && (
            <div className="card scanner-panel">
              <div className="card-header scanner-panel-header">
                <div>
                  <p className="eyebrow">Camera</p>
                  <h2>{cameraStatus}</h2>
                  <p className="small muted">Aproxime o QR a 15-25 cm e mantenha parado.</p>
                </div>
                <button className="btn btn-ghost" onClick={() => setCameraOpen(false)}>Fechar</button>
              </div>
              {cameraError && <div className="notice notice-error">{cameraError}</div>}
              <div className="scanner-box">
                <video ref={videoRef} className="scanner-video" muted playsInline />
                <div className="scanner-frame" />
              </div>
              <p className="small muted" style={{ marginTop: 10 }}>
                Use HTTPS no telemovel para a camera funcionar.
              </p>
            </div>
          )}

          <div ref={scanResultRef}>
            {scanResult && (
              <ScanResult
                key={`${scanResult.scannedTicketId}-${scanResult.reference}`}
                result={scanResult}
                loading={lookupLoading}
                onMarkOne={(ticketId) => markBoarded([ticketId])}
                onMarkAll={() => markBoarded(scanResult.tickets.map((ticket) => ticket.id))}
              />
            )}
          </div>
        </div>

        <aside className="grid dashboard-panel">
          <div className="card">
            <div className="card-header">
              <div>
                <p className="eyebrow">Dashboard</p>
                <h2>Resumo do dia</h2>
              </div>
              <CalendarDays color="var(--orange)" />
            </div>
            <div className="actions" style={{ marginTop: 12 }}>
              {EVENT_DATES.map((date) => (
                <button
                  key={date}
                  className={`btn ${selectedDate === date ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => resetStatsForDate(date)}
                >
                  {date === '2026-06-20' ? '20 Jun' : '21 Jun'}
                </button>
              ))}
              <input className="input" style={{ maxWidth: 170 }} type="date" value={selectedDate} onChange={(event) => resetStatsForDate(event.target.value)} />
            </div>
            <div className="stats" style={{ marginTop: 14 }}>
              <div className="stat"><span className="muted small">Total</span><strong>{totals.total}</strong></div>
              <div className="stat"><span className="muted small">Embarcados</span><strong>{totals.boarded}</strong></div>
              <div className="stat"><span className="muted small">Bilhetes lidos</span><strong>{totals.scanned}</strong></div>
              <div className="stat"><span className="muted small">Confirmados</span><strong>{totals.confirmed}</strong></div>
              <div className="stat"><span className="muted small">Faltam</span><strong>{totals.pending}</strong></div>
              <div className="stat"><span className="muted small">Rotas</span><strong>{stats.length}</strong></div>
            </div>
            <button className="btn btn-ghost dashboard-toggle" onClick={openDashboard}>
              {showDashboard ? 'Esconder rotas' : 'Ver rotas do dia'}
            </button>
          </div>

          {showDashboard && <div className="card">
            <div className="card-header">
              <div>
                <p className="eyebrow">Por hora e rota</p>
                <h2>Passageiros</h2>
              </div>
              {statsLoading && <Loader2 />}
            </div>
            <div style={{ marginTop: 12 }}>
              {!statsLoaded && !statsLoading && <p className="muted">Toque em Atualizar para carregar os dados.</p>}
              {statsLoaded && stats.length === 0 && <p className="muted">Sem bilhetes pagos para esta data.</p>}
              {stats.map((group) => (
                <div className="route-row" key={`${group.time}-${group.route}`}>
                  <div>
                    <strong>{group.time} - {group.route}</strong>
                    <p className="small muted">{group.total} passageiros</p>
                  </div>
                  <div className="actions">
                    <span className="pill">{group.scanned} lidos</span>
                    <span className="pill">{group.confirmed} confirmados</span>
                    <span className="pill pill-ok">{group.boarded} ok</span>
                    <span className="pill pill-warn">{group.pending} faltam</span>
                  </div>
                </div>
              ))}
            </div>
          </div>}
        </aside>
      </section>
    </main>
  );
}

function ScanResult({ result, loading, onMarkOne, onMarkAll }) {
  const [showGroup, setShowGroup] = useState(false);
  const allBoarded = result.tickets.every((ticket) => isBoarded(ticket, result.boardedIds));
  const boardedCount = result.tickets.filter((ticket) => isBoarded(ticket, result.boardedIds)).length;
  const pendingCount = result.tickets.length - boardedCount;
  const scannedTicket = result.tickets.find((ticket) => ticket.id === result.scannedTicketId) || result.tickets[0];
  const scannedBoarded = scannedTicket ? isBoarded(scannedTicket, result.boardedIds) : false;
  const otherTickets = result.tickets.filter((ticket) => ticket.id !== scannedTicket?.id);

  return (
    <section className="card scan-result">
      <div className="card-header">
        <div>
          <p className="eyebrow">Resultado</p>
          <h2>{routeLabel(result.trip)}</h2>
          <p className="muted">
            {formatLuandaDateTime(result.trip.departure_time)} - Ref. {result.reference}
          </p>
        </div>
        {allBoarded ? <CheckCircle2 color="var(--ok)" /> : <Users color="var(--lime)" />}
      </div>

      {scannedTicket && (
        <div className={`scanned-passenger ${scannedBoarded ? 'is-boarded' : ''}`}>
          <div>
            <p className="eyebrow">Passageiro lido</p>
            <h3>{getPassengerName(scannedTicket)}</h3>
            <p className="muted">
              Lugar {scannedTicket.seat_number} - {scannedTicket.ticket_number}
              {getPassengerPhone(scannedTicket) ? ` - ${getPassengerPhone(scannedTicket)}` : ''}
            </p>
          </div>
          <div className="actions">
            <span className={`pill ${scannedBoarded ? 'pill-ok' : 'pill-warn'}`}>
              {scannedBoarded ? 'Embarcado' : 'Pendente'}
            </span>
            <button className="btn btn-primary confirm-main-button" onClick={() => onMarkOne(scannedTicket.id)} disabled={loading || scannedBoarded}>
              {scannedBoarded ? <CheckCircle2 size={20} /> : <UserCheck size={20} />}
              {scannedBoarded ? 'Confirmado' : 'Confirmar embarque'}
            </button>
          </div>
        </div>
      )}

      <div className="actions">
        <button className="btn btn-ghost" onClick={() => setShowGroup((value) => !value)}>
          <Users size={18} /> {showGroup ? 'Esconder grupo' : `Ver grupo (${result.tickets.length})`}
        </button>
        <button className="btn btn-lime" onClick={onMarkAll} disabled={loading || allBoarded}>
          <UserCheck size={18} /> Confirmar grupo todo
        </button>
        <span className="pill pill-ok">{boardedCount} embarcado{boardedCount === 1 ? '' : 's'}</span>
        <span className="pill pill-warn">{pendingCount} pendente{pendingCount === 1 ? '' : 's'}</span>
      </div>

      <p className="small muted">
        Confirme apenas quem entrou no autocarro. Quem nao for confirmado fica como pendente para saber quem nao embarcou.
      </p>

      {showGroup && (
      <div className="group-list">
        {otherTickets.map((ticket) => {
          const boarded = isBoarded(ticket, result.boardedIds);
          return (
            <div className="passenger-row" key={ticket.id}>
              <div>
                <p className="passenger-name">{getPassengerName(ticket)}</p>
                <p className="small muted">
                  Lugar {ticket.seat_number} - {ticket.ticket_number}
                  {getPassengerPhone(ticket) ? ` - ${getPassengerPhone(ticket)}` : ''}
                </p>
              </div>
              <div className="actions">
                <span className={`pill ${boarded ? 'pill-ok' : 'pill-warn'}`}>
                  {boarded ? 'Embarcado' : 'Pendente'}
                </span>
                <button className="btn btn-primary" onClick={() => onMarkOne(ticket.id)} disabled={loading || boarded}>
                  {boarded ? <CheckCircle2 size={18} /> : <UserCheck size={18} />}
                  Confirmar
                </button>
              </div>
            </div>
          );
        })}
      </div>
      )}

      {allBoarded && (
        <div className="notice notice-ok">
          Todos os passageiros desta referencia para esta viagem ja foram marcados como embarcados.
        </div>
      )}
      {result.tickets.some((ticket) => ticket.payment_status !== 'paid') && (
        <div className="notice notice-error">
          Existe bilhete sem pagamento confirmado neste grupo.
        </div>
      )}
    </section>
  );
}
