'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import {
  ArrowLeft,
  Camera,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Loader2,
  LogOut,
  Luggage,
  Phone,
  QrCode,
  RefreshCw,
  ScanLine,
  Search,
  ShieldCheck,
  UserCheck,
  Users,
  XCircle,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';

const ALLOWED_ROLES = new Set(['admin', 'agent', 'driver', 'motorista']);

function getTodayLuandaDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Luanda',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

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
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function formatLuandaDateTime(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('pt-PT', {
    timeZone: 'Africa/Luanda',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatLuandaTime(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('pt-PT', {
    timeZone: 'Africa/Luanda',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
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

const PASSENGER_LIST_META = {
  total: { label: 'Compraram', icon: Users, pillClass: 'pill' },
  embarcados: { label: 'Embarcados', icon: UserCheck, pillClass: 'pill-ok' },
  faltam: { label: 'Faltam embarcar', icon: XCircle, pillClass: 'pill-warn' },
  confirmados: { label: 'Confirmados', icon: CheckCircle2, pillClass: 'pill-ok' },
};

const LUGGAGE_SIZES = [
  { value: 'pequeno', label: 'Pequeno' },
  { value: 'medio', label: 'Médio' },
  { value: 'grande', label: 'Grande' },
  { value: 'muito_grande', label: 'Muito Grande' },
];

export default function ScannerApp() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [mode, setMode] = useState(null); // null = chooser, 'embarque', 'bagagem'
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(true);

  const [selectedDate, setSelectedDate] = useState(getTodayLuandaDate);
  const [statsLoading, setStatsLoading] = useState(false);
  const [stats, setStats] = useState([]);
  const [statsLoaded, setStatsLoaded] = useState(false);
  const [selectedRouteKey, setSelectedRouteKey] = useState('');
  const [passengerList, setPassengerList] = useState(null);

  const [manualInput, setManualInput] = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [scanError, setScanError] = useState('');
  const [scanMessage, setScanMessage] = useState('');
  const [scanResult, setScanResult] = useState(null);

  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [cameraStatus, setCameraStatus] = useState('Pronto para ler QR');
  const [isScanning, setIsScanning] = useState(false);
  const statsRequestRef = useRef(0);
  const videoRef = useRef(null);
  const scanResultRef = useRef(null);
  const streamRef = useRef(null);
  const readerRef = useRef(null);
  const controlsRef = useRef(null);
  const processingRef = useRef(false);
  const lastScanRef = useRef({ value: '', at: 0 });

  useEffect(() => {
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (nextSession?.user) {
        setTimeout(() => loadProfile(nextSession.user.id), 0);
      } else {
        setProfile(null);
      }
      setAuthLoading(false);
    });

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

  useEffect(() => {
    if (profile) {
      setPassengerList(null);
      loadStats();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, selectedDate]);

  useEffect(() => {
    if (!scanError && !scanMessage) return undefined;
    const timeoutId = window.setTimeout(() => {
      setScanError('');
      setScanMessage('');
    }, 8000);
    return () => window.clearTimeout(timeoutId);
  }, [scanError, scanMessage]);

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

  async function resetToChooser() {
    await stopCamera();
    setCameraOpen(false);
    setScanResult(null);
    setManualInput('');
    setScanError('');
    setScanMessage('');
    setPassengerList(null);
    setMode(null);
  }

  async function loadStats() {
    const requestId = statsRequestRef.current + 1;
    statsRequestRef.current = requestId;
    setStatsLoading(true);
    setScanError('');
    try {
      const range = luandaRange(selectedDate);
      if (!range) {
        if (requestId === statsRequestRef.current) {
          setStats([]);
          setSelectedRouteKey('');
          setStatsLoaded(true);
        }
        return;
      }
      const { data: trips, error: tripsError } = await supabase
        .from('trips')
        .select('id, departure_time, arrival_time, status, routes(origin_city, destination_city)')
        .gte('departure_time', range.start)
        .lt('departure_time', range.end)
        .neq('status', 'cancelled')
        .order('departure_time', { ascending: true });

      if (tripsError) throw tripsError;
      const tripIds = (trips || []).map((trip) => trip.id);
      if (tripIds.length === 0) {
        if (requestId === statsRequestRef.current) {
          setStats([]);
          setSelectedRouteKey('');
          setStatsLoaded(true);
        }
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

      for (const trip of trips || []) {
        const time = formatLuandaTime(trip.departure_time);
        const route = routeLabel(trip);
        const key = `${time}|${route}`;
        if (!groups.has(key)) {
          groups.set(key, { key, time, route, tripIds: [], total: 0, scanned: 0, confirmed: 0, boarded: 0 });
        }
        groups.get(key).tripIds.push(trip.id);
      }

      for (const ticket of tickets || []) {
        const trip = tripMap.get(ticket.trip_id);
        if (!trip) continue;
        const key = `${formatLuandaTime(trip.departure_time)}|${routeLabel(trip)}`;
        const group = groups.get(key);
        if (!group) continue;
        group.total += 1;
        if (boardedIds.has(ticket.id)) group.scanned += 1;
        if (ticket.status === 'used') group.confirmed += 1;
        if (ticket.status === 'used' || boardedIds.has(ticket.id)) group.boarded += 1;
      }

      const nextStats = [...groups.values()]
        .map((group) => ({ ...group, pending: group.total - group.boarded }))
        .sort((a, b) => a.time.localeCompare(b.time) || a.route.localeCompare(b.route));
      if (requestId === statsRequestRef.current) {
        setStats(nextStats);
        setSelectedRouteKey((current) => (
          nextStats.some((group) => group.key === current) ? current : (nextStats[0]?.key || '')
        ));
        setStatsLoaded(true);
      }
    } catch (error) {
      if (requestId === statsRequestRef.current) {
        setScanError(`Erro ao carregar rotas para a data selecionada: ${error.message}`);
      }
    } finally {
      if (requestId === statsRequestRef.current) setStatsLoading(false);
    }
  }

  async function openPassengerList(type) {
    if (!selectedRoute || !selectedRoute.tripIds?.length) return;
    const route = selectedRoute;
    setPassengerList({ type, route, loading: true, error: '', passengers: [], boardedIds: new Set() });

    try {
      const select = `
        id,
        ticket_number,
        payment_reference,
        trip_id,
        seat_number,
        status,
        payment_status,
        booking_time,
        created_at,
        ticket_companions(name, phone),
        profiles!fk_passenger_id(first_name, last_name, phone_number),
        trips(departure_time)
      `;

      const { data: tickets, error } = await supabase
        .from('tickets')
        .select(select)
        .in('trip_id', route.tripIds)
        .eq('payment_status', 'paid')
        .in('status', ['active', 'used'])
        .order('seat_number', { ascending: true });

      if (error) throw error;

      const ids = (tickets || []).map((ticket) => ticket.id);
      const { data: scans, error: scansError } = ids.length
        ? await supabase
            .from('ticket_scans')
            .select('ticket_id')
            .in('ticket_id', ids)
            .eq('scan_type', 'boarding')
        : { data: [], error: null };

      if (scansError) throw scansError;
      const boardedIds = new Set((scans || []).map((scan) => scan.ticket_id));

      const references = [...new Set((tickets || []).map((ticket) => ticket.payment_reference).filter(Boolean))];
      const { data: payments, error: paymentsError } = references.length
        ? await supabase
            .from('payment_transactions')
            .select('transaction_id, gateway_response')
            .in('transaction_id', references)
        : { data: [], error: null };

      if (paymentsError) throw paymentsError;
      const paymentsByRef = new Map((payments || []).map((payment) => [payment.transaction_id, payment]));

      const enriched = (tickets || []).map((ticket) => ({
        ...ticket,
        booking_companion: getBookingCompanion(
          paymentsByRef.get(ticket.payment_reference)?.gateway_response?.booking_details,
          ticket
        ),
      }));

      const passengers = enriched.filter((ticket) => {
        const boarded = ticket.status === 'used' || boardedIds.has(ticket.id);
        if (type === 'confirmados') return ticket.status === 'used';
        if (type === 'embarcados') return boarded;
        if (type === 'faltam') return !boarded;
        return true;
      });

      setPassengerList((current) => (
        current && current.type === type && current.route.key === route.key
          ? { ...current, loading: false, passengers, boardedIds }
          : current
      ));
    } catch (error) {
      setPassengerList((current) => (
        current && current.type === type && current.route.key === route.key
          ? { ...current, loading: false, error: error.message }
          : current
      ));
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

  async function addLuggage({ description, size, amountKz }) {
    const ticket =
      scanResult?.tickets?.find((item) => item.id === scanResult.scannedTicketId) ||
      scanResult?.tickets?.[0];
    if (!ticket || !profile) return false;

    setScanError('');
    setScanMessage('');

    const { error } = await supabase.from('luggage').insert({
      ticket_id: ticket.id,
      description,
      size,
      amount_kz: amountKz,
      status: 'pending',
      created_by: profile.id,
    });

    if (error) {
      setScanError(`Erro ao guardar bagagem: ${error.message}`);
      return false;
    }

    setScanMessage('Bagagem adicionada. Pagamento pendente no embarque.');
    return true;
  }

  const selectedRoute = useMemo(
    () => stats.find((group) => group.key === selectedRouteKey) || stats[0] || null,
    [stats, selectedRouteKey]
  );

  if (authLoading) {
    return (
      <main className="login">
        <div className="card login-card loading-card">
          <Loader2 className="spin" size={32} />
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

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            {mode === 'bagagem' ? <Luggage size={24} /> : <QrCode size={24} />}
          </div>
          <div>
            <p className="eyebrow">NawaBus Scanner</p>
            <h1>
              {mode === null
                ? 'Escolha uma operacao'
                : mode === 'bagagem'
                ? 'Adicionar Bagagem'
                : 'Embarque Mangais'}
            </h1>
            <p className="muted">Logado como {displayName} - {profile.role}</p>
          </div>
        </div>
        <div className="actions">
          {mode !== null && (
            <button className="btn btn-ghost" onClick={resetToChooser}>
              <ArrowLeft size={18} /> Voltar
            </button>
          )}
          {mode === 'embarque' && (
            <button className="btn btn-ghost" onClick={loadStats} disabled={statsLoading}>
              <RefreshCw size={18} /> Atualizar
            </button>
          )}
          <button className="btn btn-danger" onClick={signOut}>
            <LogOut size={18} /> Sair
          </button>
        </div>
      </header>

      {(scanError || scanMessage) && (
        <div className="notice-stack">
          {scanError && <div className="notice notice-error transient-notice">{scanError}</div>}
          {scanMessage && <div className="notice notice-ok transient-notice">{scanMessage}</div>}
        </div>
      )}

      {mode === null && (
        <section className="mode-grid">
          <button className="card mode-card" onClick={() => setMode('embarque')}>
            <span className="mode-card-icon"><ScanLine size={28} /></span>
            <span className="mode-card-text">
              <h2>Scanear Embarque</h2>
              <p className="muted small">Ler QR dos bilhetes e confirmar quem entrou no autocarro.</p>
            </span>
            <ChevronRight className="muted" />
          </button>
          <button className="card mode-card" onClick={() => setMode('bagagem')}>
            <span className="mode-card-icon"><Luggage size={28} /></span>
            <span className="mode-card-text">
              <h2>Adicionar Bagagem</h2>
              <p className="muted small">Ler o bilhete e registar bagagem para pagamento no embarque.</p>
            </span>
            <ChevronRight className="muted" />
          </button>
        </section>
      )}

      {mode !== null && (
        <section className="grid scanner-layout">
          <div className="grid">
            <div className="card scanner-home-card">
              <div className="card-header">
                <div>
                  <p className="eyebrow">Operacao</p>
                  <h2>{mode === 'bagagem' ? 'Escanear bilhete para bagagem' : 'Escanear bilhete'}</h2>
                  <p className="muted">
                    {mode === 'bagagem'
                      ? 'Leia o QR do bilhete ou digite a referencia para registar a bagagem do passageiro.'
                      : 'Leia o QR do PDF ou digite a referencia. Depois confirme apenas quem entrou no autocarro.'}
                  </p>
                </div>
                <ShieldCheck color="var(--lime)" />
              </div>
              <div className="scanner-primary-action">
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
                mode === 'bagagem' ? (
                  <LuggagePanel
                    key={scanResult.scannedTicketId}
                    result={scanResult}
                    loading={lookupLoading}
                    onAdd={addLuggage}
                  />
                ) : (
                  <ScanResult
                    key={`${scanResult.scannedTicketId}-${scanResult.reference}`}
                    result={scanResult}
                    loading={lookupLoading}
                    onMarkOne={(ticketId) => markBoarded([ticketId])}
                    onMarkAll={() => markBoarded(scanResult.tickets.map((ticket) => ticket.id))}
                  />
                )
              )}
            </div>
          </div>

          {mode === 'embarque' && (
            <aside className="grid dashboard-panel">
              <div className="card">
                <div className="card-header">
                  <div>
                    <p className="eyebrow">Rota selecionada</p>
                    <h2>{selectedRoute ? `${selectedRoute.time} - ${selectedRoute.route}` : 'Sem rotas na data selecionada'}</h2>
                    <p className="muted small">{selectedDate}</p>
                  </div>
                  <CalendarDays color="var(--lime)" />
                </div>

                <div className="field" style={{ marginTop: 14 }}>
                  <label htmlFor="scanner-date">Data da viagem</label>
                  <input
                    id="scanner-date"
                    className="input"
                    type="date"
                    value={selectedDate}
                    onChange={(event) => setSelectedDate(event.target.value)}
                  />
                </div>

                {stats.length > 1 && (
                  <div className="field" style={{ marginTop: 14 }}>
                    <label>Escolher rota</label>
                    <select className="input" value={selectedRoute?.key || ''} onChange={(event) => setSelectedRouteKey(event.target.value)}>
                      {stats.map((group) => (
                        <option key={group.key} value={group.key}>
                          {group.time} - {group.route}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {statsLoading && <p className="muted"><Loader2 size={16} /> A carregar rotas...</p>}
                {statsLoaded && stats.length === 0 && <p className="muted">Sem bilhetes pagos para esta data.</p>}

                {selectedRoute && (
                  <>
                  <div className="stats route-detail-stats" style={{ marginTop: 14 }}>
                    <button type="button" className="stat stat-clickable" onClick={() => openPassengerList('total')}>
                      <span className="muted small">Compraram</span><strong>{selectedRoute.total}</strong>
                      <ChevronRight className="stat-chevron" size={16} />
                    </button>
                    <button type="button" className="stat stat-clickable" onClick={() => openPassengerList('embarcados')}>
                      <span className="muted small">Embarcados</span><strong>{selectedRoute.boarded}</strong>
                      <ChevronRight className="stat-chevron" size={16} />
                    </button>
                    <button type="button" className="stat stat-clickable" onClick={() => openPassengerList('faltam')}>
                      <span className="muted small">Faltam</span><strong>{selectedRoute.pending}</strong>
                      <ChevronRight className="stat-chevron" size={16} />
                    </button>
                  </div>
                  <div className="actions" style={{ marginTop: 12 }}>
                    <span className="pill">{selectedRoute.scanned} bilhetes lidos</span>
                    <button type="button" className="pill pill-button" onClick={() => openPassengerList('confirmados')}>
                      {selectedRoute.confirmed} confirmados
                    </button>
                  </div>
                  </>
                )}
              </div>
            </aside>
          )}
        </section>
      )}

      {passengerList && mode === 'embarque' && (
        <PassengerListPanel
          passengerList={passengerList}
          onClose={() => setPassengerList(null)}
        />
      )}
    </main>
  );
}

function PassengerListPanel({ passengerList, onClose }) {
  const meta = PASSENGER_LIST_META[passengerList.type] || PASSENGER_LIST_META.total;
  const Icon = meta.icon;
  const isEmpty = !passengerList.loading && !passengerList.error && passengerList.passengers.length === 0;
  const hasResults = !passengerList.loading && !passengerList.error && passengerList.passengers.length > 0;

  return (
    <div className="card scanner-panel passenger-list-panel">
      <div className="scanner-panel-header passenger-list-header">
        <div className="passenger-list-heading">
          <span className={`passenger-list-icon ${meta.pillClass}`}><Icon size={20} /></span>
          <div>
            <p className="eyebrow">{meta.label}</p>
            <h2>{passengerList.route.time} - {passengerList.route.route}</h2>
          </div>
        </div>
        <div className="actions">
          {hasResults && (
            <span className={`pill ${meta.pillClass}`}>
              {passengerList.passengers.length} passageiro{passengerList.passengers.length === 1 ? '' : 's'}
            </span>
          )}
          <button className="btn btn-ghost" onClick={onClose}>Fechar</button>
        </div>
      </div>

      {passengerList.loading && (
        <p className="muted"><Loader2 size={16} className="spin" /> A carregar passageiros...</p>
      )}
      {passengerList.error && <div className="notice notice-error">{passengerList.error}</div>}
      {isEmpty && <p className="muted">Nenhum passageiro nesta categoria.</p>}

      {hasResults && (
        <div className="group-list passenger-list-body">
          {passengerList.passengers.map((ticket) => {
            const boarded = isBoarded(ticket, passengerList.boardedIds);
            const phone = getPassengerPhone(ticket);
            return (
              <div className="passenger-row" key={ticket.id}>
                <div>
                  <p className="passenger-name">{getPassengerName(ticket)}</p>
                  <p className="small muted">
                    Lugar {ticket.seat_number} - {ticket.ticket_number}
                    {phone ? ` - ${phone}` : ''}
                  </p>
                  <p className="small muted">
                    Comprado: {formatLuandaDateTime(ticket.booking_time || ticket.created_at)}
                    {' - '}Embarque: {formatLuandaDateTime(ticket.trips?.departure_time)}
                  </p>
                </div>
                <div className="actions passenger-row-actions">
                  <span className={`pill ${boarded ? 'pill-ok' : 'pill-warn'}`}>
                    {boarded ? 'Embarcado' : 'Pendente'}
                  </span>
                  {phone && (
                    <a className="btn btn-ghost call-btn" href={`tel:${phone}`}>
                      <Phone size={16} /> Ligar
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
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

function LuggagePanel({ result, loading, onAdd }) {
  const [description, setDescription] = useState('');
  const [size, setSize] = useState('pequeno');
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [added, setAdded] = useState([]);

  const scannedTicket = result.tickets.find((ticket) => ticket.id === result.scannedTicketId) || result.tickets[0];

  async function handleSubmit(event) {
    event.preventDefault();
    setFormError('');

    const trimmedDescription = description.trim();
    if (!trimmedDescription) {
      setFormError('Descreva o que o passageiro esta a levar.');
      return;
    }

    const amountKz = Number(amount);
    if (!Number.isFinite(amountKz) || amountKz < 0) {
      setFormError('Indique um valor valido.');
      return;
    }

    setSaving(true);
    const ok = await onAdd({ description: trimmedDescription, size, amountKz });
    setSaving(false);

    if (ok) {
      setAdded((current) => [...current, { description: trimmedDescription, size, amountKz }]);
      setDescription('');
      setAmount('');
    }
  }

  return (
    <section className="card scan-result">
      <div className="card-header">
        <div>
          <p className="eyebrow">Passageiro lido</p>
          <h2>{getPassengerName(scannedTicket)}</h2>
          <p className="muted">
            {routeLabel(result.trip)} - Lugar {scannedTicket?.seat_number} - {scannedTicket?.ticket_number}
          </p>
        </div>
        <Luggage color="var(--lime)" />
      </div>

      <form className="grid" onSubmit={handleSubmit} style={{ marginTop: 14 }}>
        <div className="field">
          <label>Bagagem</label>
          <textarea
            className="input"
            rows={3}
            placeholder="O que esta a levar"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <div className="field">
          <label>Tamanho</label>
          <select className="input" value={size} onChange={(event) => setSize(event.target.value)}>
            {LUGGAGE_SIZES.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Valor (Kz)</label>
          <input
            className="input"
            type="number"
            min="0"
            inputMode="numeric"
            placeholder="0"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </div>
        {formError && <div className="notice notice-error">{formError}</div>}
        <button className="btn btn-primary" disabled={saving || loading}>
          {saving ? <Loader2 size={18} className="spin" /> : <Luggage size={18} />} Adicionar
        </button>
      </form>

      {added.length > 0 && (
        <div className="group-list" style={{ marginTop: 14 }}>
          {added.map((item, index) => (
            <div className="passenger-row" key={index}>
              <div>
                <p className="passenger-name">{item.description}</p>
                <p className="small muted">
                  {LUGGAGE_SIZES.find((option) => option.value === item.size)?.label} - Kz {item.amountKz}
                </p>
              </div>
              <span className="pill pill-warn">Pendente</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
