import { useState, useEffect, useRef } from "react";
import { Menu, Settings, Star, Wallet, LayoutGrid, ListOrdered, Plus, User, MoreVertical, MapPin, List, Map, Upload, Clock, CheckCircle2, XCircle, AlertCircle } from "lucide-react";
import SidebarMenu, { SidebarScreen } from "./SidebarMenu";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import ActiveTaskScreen from "./ActiveTaskScreen";
import { Offer } from "./OfferCard";
import { useUserRating } from "@/hooks/useUserRating";
import SettingsScreen from "./SettingsScreen";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

interface LiveTask {
  id: string;
  title: string;
  description: string | null;
  price: number;
  category: string;
  client_id: string;
  clientName: string;
  location_address: string | null;
  created_at: string;
}

type TaskerTab = "solicitudes" | "desempeno" | "cartera";

interface TaskerViewProps {
  onBack: () => void;
  onSidebarNavigate?: (screen: SidebarScreen) => void;
  onSwitchMode?: () => void;
}

const TaskerView = ({ onBack, onSidebarNavigate, onSwitchMode }: TaskerViewProps) => {
  const { profile, user, refreshProfile } = useAuth();
  const { rating, count } = useUserRating(user?.id);

  // Refresh profile on mount to get latest tasker_status
  useEffect(() => {
    refreshProfile();
  }, []);
  const [activeTab, setActiveTab] = useState<TaskerTab>("solicitudes");
  const [isAvailable, setIsAvailable] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [tasks, setTasks] = useState<LiveTask[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [sendingOffer, setSendingOffer] = useState<string | null>(null);
  const [sentOffers, setSentOffers] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<"list" | "map">("list");
  const [selectedTask, setSelectedTask] = useState<LiveTask | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.Marker[]>([]);
  const [counterOfferTask, setCounterOfferTask] = useState<LiveTask | null>(null);
  const [counterPrice, setCounterPrice] = useState("");
  const [acceptedChat, setAcceptedChat] = useState<{ taskId: string; taskTitle: string; taskDescription: string | null; taskPrice: number; taskCategory: string; clientName: string; clientId: string; clientPhone?: string | null; locationAddress: string | null; locationLat: number | null; locationLng: number | null; offerId: string } | null>(null);

  // Load open tasks and subscribe to new ones
  useEffect(() => {
    const loadTasks = async () => {
      setLoadingTasks(true);
      const { data, error } = await supabase
        .from("tasks")
        .select("*")
        .eq("status", "open")
        .order("created_at", { ascending: false });

      if (data) {
        // Fetch client names separately to avoid FK join issues
        const tasksWithNames = await Promise.all(
          data.map(async (task) => {
            const { data: prof } = await supabase
              .from("profiles")
              .select("full_name")
              .eq("user_id", task.client_id)
              .single();
            return { ...task, clientName: prof?.full_name || "Cliente" };
          })
        );
        setTasks(tasksWithNames.map(rowToTask));
      }
      setLoadingTasks(false);
    };
    loadTasks();

    // Load already-sent offers by this tasker
    const loadSentOffers = async () => {
      if (!user) return;
      const { data } = await supabase
        .from("offers")
        .select("task_id")
        .eq("tasker_id", user.id);
      if (data) setSentOffers(new Set(data.map((o) => o.task_id)));
    };
    loadSentOffers();

    // Check if tasker already has an accepted offer active (only non-completed tasks)
    const loadActiveOffer = async () => {
      if (!user) return;
      const { data: offer } = await supabase
        .from("offers")
        .select("*")
        .eq("tasker_id", user.id)
        .eq("status", "accepted")
        .maybeSingle();
      if (!offer) return;
      // Only show if task is still active (not completed/cancelled)
      const { data: task } = await supabase
        .from("tasks")
        .select("*")
        .eq("id", offer.task_id)
        .in("status", ["accepted", "in_progress"])
        .maybeSingle();
      if (!task) return;
      const { data: prof } = await supabase.from("profiles").select("full_name, phone").eq("user_id", task.client_id).single();
      setAcceptedChat({
        taskId: task.id, taskTitle: task.title, taskDescription: task.description,
        taskPrice: offer.price, taskCategory: task.category,
        clientName: prof?.full_name || "Cliente", clientId: task.client_id,
        clientPhone: (prof as any)?.phone ?? null,
        locationAddress: (task as any).location_address ?? null,
        locationLat: (task as any).location_lat ?? null,
        locationLng: (task as any).location_lng ?? null,
        offerId: offer.id,
      });
    };
    loadActiveOffer();

    // Realtime: new tasks
    const channel = supabase
      .channel("open-tasks")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "tasks", filter: "status=eq.open" },
        async (payload) => {
          const { data: profile } = await supabase
            .from("profiles")
            .select("full_name")
            .eq("user_id", payload.new.client_id)
            .single();
          const task: LiveTask = {
            ...payload.new as any,
            clientName: profile?.full_name || "Cliente",
          };
          setTasks((prev) => [task, ...prev]);
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "tasks" },
        (payload) => {
          // Remove tasks that are no longer open
          if (payload.new.status !== "open") {
            setTasks((prev) => prev.filter((t) => t.id !== payload.new.id));
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user]);

  // Listen for accepted offers (tasker side) - listen to tasks becoming accepted
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`tasker-task-accepted-${user.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "tasks" },
        async (payload) => {
          if (payload.new.status !== "accepted" || !payload.new.accepted_offer_id) return;
          // Check if the accepted offer belongs to this tasker
          const { data: offer } = await supabase
            .from("offers")
            .select("*")
            .eq("id", payload.new.accepted_offer_id)
            .eq("tasker_id", user.id)
            .maybeSingle();
          if (!offer) return; // Not this tasker's offer
          const task = payload.new;
          const { data: prof } = await supabase
            .from("profiles")
            .select("full_name, phone")
            .eq("user_id", task.client_id)
            .single();
          setAcceptedChat({
            taskId: task.id,
            taskTitle: task.title,
            taskDescription: task.description,
            taskPrice: offer.price,
            taskCategory: task.category,
            clientName: prof?.full_name || "Cliente",
            clientId: task.client_id,
            clientPhone: (prof as any)?.phone ?? null,
            locationAddress: (task as any).location_address ?? null,
            locationLat: (task as any).location_lat ?? null,
            locationLng: (task as any).location_lng ?? null,
            offerId: offer.id,
          });
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user]);

  const rowToTask = (row: any): LiveTask => ({
    id: row.id,
    title: row.title,
    description: row.description,
    price: row.price,
    category: row.category,
    client_id: row.client_id,
    clientName: row.clientName || row.profiles?.full_name || "Cliente",
    location_address: row.location_address ?? null,
    created_at: row.created_at,
  });

  const handleSendOffer = async (task: LiveTask, customPrice?: number) => {
    if (!user || sentOffers.has(task.id)) return;
    setSendingOffer(task.id);
    const price = customPrice ?? task.price;
    const message = customPrice
      ? `Hola, puedo realizar esta tarea por COL$${customPrice.toLocaleString()}`
      : `Hola, acepto realizar esta tarea al precio propuesto`;
    const { error } = await supabase.from("offers").insert({
      task_id: task.id, tasker_id: user.id, price, message, status: "pending",
    });
    if (!error) setSentOffers((prev) => new Set([...prev, task.id]));
    setSendingOffer(null);
    setCounterOfferTask(null);
    setCounterPrice("");
  };

  const handleSubmitCounter = () => {
    if (!counterOfferTask || !counterPrice) return;
    const p = parseFloat(counterPrice);
    if (isNaN(p) || p <= 0) return;
    handleSendOffer(counterOfferTask, p);
  };

  const [todayEarnings, setTodayEarnings] = useState(0);
  const [weekEarnings, setWeekEarnings] = useState(0);
  const [monthEarnings, setMonthEarnings] = useState(0);
  const [earningsTab, setEarningsTab] = useState<"day" | "week" | "month">("day");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [showRecharge, setShowRecharge] = useState(false);
  const [rechargeAmount, setRechargeAmount] = useState("");
  const [rechargeFile, setRechargeFile] = useState<File | null>(null);
  const [submittingRecharge, setSubmittingRecharge] = useState(false);
  const [rechargeHistory, setRechargeHistory] = useState<{ id: string; amount: number; status: string; created_at: string }[]>([]);
  const rechargeFileRef = useRef<HTMLInputElement>(null);

  // Load avatar
  useEffect(() => {
    if (!user) return;
    const path = (profile as any)?.avatar_path;
    if (path) {
      supabase.storage.from("documents").createSignedUrl(path, 3600).then(({ data }) => {
        if (data?.signedUrl) setAvatarUrl(data.signedUrl);
      });
    }
  }, [user, profile]);

  // Load earnings for day / week / month from tasker_earnings table
  useEffect(() => {
    if (!user) return;
    const loadEarnings = async () => {
      const now = new Date();
      const startOfDay   = new Date(now); startOfDay.setHours(0, 0, 0, 0);
      const startOfWeek  = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay()); startOfWeek.setHours(0, 0, 0, 0);
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      const { data: earnings } = await supabase
        .from("tasker_earnings" as any)
        .select("amount, created_at")
        .eq("tasker_id", user.id);

      if (!earnings) return;

      let day = 0, week = 0, month = 0;
      (earnings as unknown as { amount: number; created_at: string }[]).forEach((e) => {
        const d = new Date(e.created_at);
        if (d >= startOfDay)   day   += e.amount;
        if (d >= startOfWeek)  week  += e.amount;
        if (d >= startOfMonth) month += e.amount;
      });

      setTodayEarnings(day);
      setWeekEarnings(week);
      setMonthEarnings(month);
    };
    loadEarnings();
  }, [user]);
  // Load recharge history
  useEffect(() => {
    if (!user || activeTab !== "cartera") return;
    supabase
      .from("credit_recharges" as any)
      .select("id, amount, status, created_at")
      .eq("tasker_id", user.id)
      .order("created_at", { ascending: false })
      .limit(10)
      .then(({ data }) => {
        if (data) setRechargeHistory(data as any);
      });
  }, [user, activeTab]);

  const handleSubmitRecharge = async () => {
    if (!user || !rechargeAmount || parseFloat(rechargeAmount) <= 0) return;
    setSubmittingRecharge(true);
    try {
      let receiptPath: string | null = null;
      if (rechargeFile) {
        const ext = rechargeFile.name.split(".").pop() || "jpg";
        const path = `${user.id}/recharge_${Date.now()}.${ext}`;
        const buf = await rechargeFile.arrayBuffer();
        const { error: upErr } = await supabase.storage
          .from("documents")
          .upload(path, new Uint8Array(buf), { upsert: true, contentType: rechargeFile.type || "image/jpeg" });
        if (!upErr) receiptPath = path;
      }
      const { error } = await supabase.from("credit_recharges" as any).insert({
        tasker_id: user.id,
        amount: parseInt(rechargeAmount),
        receipt_path: receiptPath,
        status: "pending",
      });
      if (error) throw new Error(error.message);
      setShowRecharge(false);
      setRechargeAmount("");
      setRechargeFile(null);
      // Refresh history
      const { data } = await supabase
        .from("credit_recharges" as any)
        .select("id, amount, status, created_at")
        .eq("tasker_id", user.id)
        .order("created_at", { ascending: false })
        .limit(10);
      if (data) setRechargeHistory(data as any);
      alert("✅ Solicitud enviada. El administrador revisará tu comprobante y acreditará los créditos.");
    } catch (err: any) {
      alert("Error: " + err.message);
    } finally {
      setSubmittingRecharge(false);
    }
  };

  useEffect(() => {
    // Also reinitialize when sidebar closes while in map mode
    if (sidebarOpen) return;
    if (activeTab !== "solicitudes" || viewMode !== "map") return;

    const timer = setTimeout(() => {
      if (!mapContainerRef.current) return;

      // Destroy previous instance to avoid blank-map bug on Android WebView
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
        markersRef.current = [];
      }
      mapContainerRef.current.innerHTML = "";

      const map = L.map(mapContainerRef.current, {
        center: [1.2136, -77.2811],
        zoom: 13,
        zoomControl: false,
        attributionControl: false,
      });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        crossOrigin: true,
      }).addTo(map);
      mapInstanceRef.current = map;

      // Multiple invalidateSize calls for Android WebView layout delays
      setTimeout(() => map.invalidateSize(), 150);
      setTimeout(() => map.invalidateSize(), 500);
      setTimeout(() => map.invalidateSize(), 1000);

      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];

      const bounds: [number, number][] = [];

      tasks.forEach(async (task) => {
        let lat = (task as any).location_lat;
        let lng = (task as any).location_lng;

        if ((!lat || !lng) && task.location_address) {
          try {
            const query = task.location_address.includes("Pasto")
              ? task.location_address
              : `${task.location_address}, Pasto, Nariño, Colombia`;
            const res = await fetch(
              `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=co&viewbox=-77.45,1.10,-77.15,1.35&bounded=1`,
              { headers: { "Accept-Language": "es" } }
            );
            const data = await res.json();
            if (data[0]) { lat = parseFloat(data[0].lat); lng = parseFloat(data[0].lon); }
          } catch { /* skip */ }
        }

        if (!lat || !lng) return;

        const icon = L.divIcon({
          html: `<div style="background:#1E9FE8;color:white;font-weight:800;font-size:12px;padding:4px 8px;border-radius:20px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.3);border:2px solid white;cursor:pointer;">
            COL${Number(task.price).toLocaleString("es-CO")}
          </div>`,
          className: "",
          iconAnchor: [40, 16],
        });

        const marker = L.marker([lat, lng], { icon })
          .addTo(map)
          .on("click", () => setSelectedTask(task));

        markersRef.current.push(marker);
        bounds.push([lat, lng]);

        if (bounds.length === 1) {
          map.setView([lat, lng], 14);
        } else {
          map.fitBounds(bounds, { padding: [60, 60] });
        }
      });
    }, 150);

    return () => clearTimeout(timer);
  }, [viewMode, activeTab, tasks, sidebarOpen]);

  const taskerStatus = (profile as any)?.tasker_status ?? "pending";

  if (taskerStatus !== "approved") {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-8 text-center">
        <div className={`w-20 h-20 rounded-full flex items-center justify-center mb-4 ${taskerStatus === "rejected" ? "bg-destructive/10" : "bg-yellow-100"}`}>
          <span className="text-4xl">{taskerStatus === "rejected" ? "❌" : "⏳"}</span>
        </div>
        <h2 className="text-xl font-extrabold text-foreground mb-2">
          {taskerStatus === "rejected" ? "Solicitud rechazada" : "Cuenta en revisión"}
        </h2>
        <p className="text-sm text-muted-foreground mb-6">
          {taskerStatus === "rejected"
            ? "Tu solicitud como Tasker fue rechazada. Contacta al soporte para más información."
            : "Un administrador está revisando tus documentos. Te notificaremos cuando tu cuenta sea aprobada."}
        </p>
        {onSwitchMode && (
          <button onClick={onSwitchMode} className="px-6 py-3 rounded-2xl bg-brand-gradient text-white font-bold text-sm">
            Volver a modo Cliente
          </button>
        )}
      </div>
    );
  }

  // If there's an active task, render ONLY the ActiveTaskScreen — no background maps
  if (acceptedChat) {
    return (
      <ActiveTaskScreen
        task={{
          id: acceptedChat.taskId,
          title: acceptedChat.taskTitle,
          description: acceptedChat.taskDescription,
          price: acceptedChat.taskPrice,
          category: acceptedChat.taskCategory,
          clientName: acceptedChat.clientName,
          client_id: acceptedChat.clientId,
          tasker_id: user?.id,
          otherUserPhone: acceptedChat.clientPhone ?? null,
          location_address: acceptedChat.locationAddress,
          location_lat: acceptedChat.locationLat,
          location_lng: acceptedChat.locationLng,
          offerId: acceptedChat.offerId,
        }}
        onDone={() => setAcceptedChat(null)}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Counter offer modal */}
      {counterOfferTask && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end">
          <div className="w-full bg-card rounded-t-3xl p-6 pb-10 animate-slide-up">
            <h3 className="text-lg font-bold text-foreground mb-1">Contraoferta</h3>
            <p className="text-sm text-muted-foreground mb-5">
              El cliente ofrece <span className="font-bold text-foreground">COL${Number(counterOfferTask.price).toLocaleString()}</span>. Propón tu precio:
            </p>
            <div className="relative mb-5">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-accent font-bold text-lg">$</span>
              <input
                type="number"
                value={counterPrice}
                onChange={(e) => setCounterPrice(e.target.value)}
                placeholder="0"
                className="w-full pl-10 pr-4 py-4 rounded-2xl bg-secondary border border-border text-foreground text-xl font-bold focus:outline-none focus:ring-2 focus:ring-primary/30"
                autoFocus
              />
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => { setCounterOfferTask(null); setCounterPrice(""); }}
                className="flex-1 py-3.5 rounded-2xl border-2 border-border text-foreground font-bold text-sm"
              >
                Cancelar
              </button>
              <button
                onClick={handleSubmitCounter}
                disabled={!counterPrice || parseFloat(counterPrice) <= 0 || sendingOffer === counterOfferTask.id}
                className="flex-1 py-3.5 rounded-2xl bg-brand-gradient text-white font-bold text-sm disabled:opacity-60"
              >
                {sendingOffer === counterOfferTask.id ? "Enviando..." : "Enviar contraoferta"}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Top bar */}
      <div className="sticky top-0 z-10 bg-card border-b border-border px-4 pt-12 pb-3">
        <div className="flex items-center justify-between">
          <button onClick={() => setSidebarOpen(true)} className="w-10 h-10 flex items-center justify-center">
            <Menu className="w-6 h-6 text-foreground" />
          </button>
          <button
            onClick={() => setIsAvailable(!isAvailable)}
            className={`px-5 py-2 rounded-full font-bold text-sm transition-all shadow-soft ${
              isAvailable ? "bg-green-500 hover:bg-green-600 text-white" : "bg-destructive text-destructive-foreground"
            }`}
          >
            {isAvailable ? "● Disponible" : "● Ocupado"}
          </button>
          <button onClick={() => setShowSettings(true)} className="w-10 h-10 flex items-center justify-center">
            <Settings className="w-5 h-5 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Settings overlay */}
      {showSettings && (
        <div className="fixed inset-0 z-[200] bg-background">
          <SettingsScreen onBack={() => setShowSettings(false)} />
        </div>
      )}

      {/* Content */}
      <div className={`flex-1 ${viewMode === "map" && activeTab === "solicitudes" ? "overflow-hidden" : "overflow-y-auto pb-20"}`}>
        {activeTab === "solicitudes" && (
          <div>
            {/* View toggle */}
            <div className="flex gap-1 bg-secondary mx-4 mt-3 mb-2 rounded-xl p-1">
              <button
                onClick={() => setViewMode("list")}
                className={`flex-1 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                  viewMode === "list" ? "bg-primary text-white shadow-soft" : "text-muted-foreground"
                }`}
              >
                <List className="w-3.5 h-3.5" /> Lista
              </button>
              <button
                onClick={() => setViewMode("map")}
                className={`flex-1 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                  viewMode === "map" ? "bg-primary text-white shadow-soft" : "text-muted-foreground"
                }`}
              >
                <Map className="w-3.5 h-3.5" /> Mapa
              </button>
            </div>

            {/* Map view — only rendered when active so container has real dimensions */}
            {viewMode === "map" && (
            <div style={{
              height: "calc(100vh - 260px)",
              position: "relative",
              overflow: "hidden",
              display: sidebarOpen ? "none" : undefined,
            }}>
              <div ref={mapContainerRef} style={{ width: "100%", height: "100%" }} />
                            {/* Selected task card */}
              {selectedTask && (
                <div className="absolute bottom-3 left-3 right-3 z-[1000] bg-card rounded-2xl shadow-elevated p-4 border border-border">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xl font-extrabold text-foreground">COL${Number(selectedTask.price).toLocaleString("es-CO")}</p>
                      <p className="text-sm font-bold text-foreground truncate">{selectedTask.title}</p>
                      {selectedTask.location_address && (
                        <p className="text-xs text-primary mt-0.5 truncate">{selectedTask.location_address}</p>
                      )}
                    </div>
                    <button onClick={() => setSelectedTask(null)} className="text-muted-foreground ml-2 text-lg leading-none">✕</button>
                  </div>
                  {sentOffers.has(selectedTask.id) ? (
                    <div className="w-full py-2.5 rounded-xl bg-secondary text-muted-foreground font-bold text-sm text-center">✓ Oferta enviada</div>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleSendOffer(selectedTask)}
                        disabled={sendingOffer === selectedTask.id || !isAvailable}
                        className="flex-1 py-2.5 rounded-xl bg-accent-gradient text-white font-bold text-sm disabled:opacity-60"
                      >
                        {sendingOffer === selectedTask.id ? "Enviando..." : "Aceptar oferta"}
                      </button>
                      <button
                        onClick={() => { setCounterOfferTask(selectedTask); setCounterPrice(String(selectedTask.price)); setSelectedTask(null); }}
                        className="flex-1 py-2.5 rounded-xl border-2 border-primary text-primary font-bold text-sm"
                      >
                        Contraoferta
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            )}

            {/* List view */}
            {viewMode === "list" && (
              <div>
            {loadingTasks && (
              <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
                Cargando tareas...
              </div>
            )}
            {!loadingTasks && tasks.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 px-8 text-center">
                <ListOrdered className="w-14 h-14 text-muted-foreground/30 mb-3" />
                <p className="font-bold text-foreground mb-1">Sin solicitudes</p>
                <p className="text-sm text-muted-foreground">Cuando un cliente publique una tarea aparecerá aquí.</p>
              </div>
            )}
            {tasks.map((task) => (
              <div key={task.id} className="border-b border-border px-4 py-4">
                <div className="flex items-start gap-3">
                  <div className="flex flex-col items-center min-w-[56px]">
                    <div className="w-11 h-11 rounded-full bg-primary/10 flex items-center justify-center">
                      <User className="w-5 h-5 text-primary" />
                    </div>
                    <span className="text-xs font-semibold text-foreground mt-1 text-center leading-tight">{task.clientName}</span>
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-2xl font-extrabold text-foreground leading-tight">
                      COL${Number(task.price).toLocaleString()}
                    </p>
                    <p className="text-sm font-bold text-foreground mt-0.5">{task.title}</p>
                    {task.description && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{task.description}</p>
                    )}
                    {task.location_address && (
                      <div className="flex items-start gap-1 mt-1.5">
                        <MapPin className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
                        <p className="text-xs text-primary font-medium line-clamp-2">{task.location_address}</p>
                      </div>
                    )}
                    <div className="mt-2">
                      <span className="px-2.5 py-1 rounded-full bg-primary/10 text-primary text-xs font-semibold">
                        {task.category}
                      </span>
                    </div>
                  </div>

                  <button className="p-1">
                    <MoreVertical className="w-5 h-5 text-muted-foreground" />
                  </button>
                </div>

                {sentOffers.has(task.id) ? (
                  <div className="mt-3 w-full py-3 rounded-2xl bg-secondary text-muted-foreground font-bold text-sm text-center">
                    ✓ Oferta enviada
                  </div>
                ) : (
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => handleSendOffer(task)}
                      disabled={sendingOffer === task.id || !isAvailable}
                      className="flex-1 py-3 rounded-2xl bg-accent-gradient text-white font-bold text-sm active:scale-[0.98] transition-all shadow-soft disabled:opacity-60"
                    >
                      {sendingOffer === task.id ? "Enviando..." : "Aceptar oferta"}
                    </button>
                    <button
                      onClick={() => { setCounterOfferTask(task); setCounterPrice(String(task.price)); }}
                      disabled={!isAvailable}
                      className="flex-1 py-3 rounded-2xl border-2 border-primary text-primary font-bold text-sm active:scale-[0.98] transition-all disabled:opacity-60"
                    >
                      Contraoferta
                    </button>
                  </div>
                )}
              </div>
            ))}
            </div>
            )}
          </div>
        )}

        {activeTab === "desempeno" && (
          <div className="pb-6">
            {/* Hero card — tier + rating */}
            <div className="bg-brand-gradient px-5 pt-6 pb-8 relative overflow-hidden">
              <div className="absolute -top-8 -right-8 w-36 h-36 rounded-full bg-white/10" />
              <div className="absolute -bottom-6 -left-6 w-24 h-24 rounded-full bg-white/10" />
              <div className="flex items-center gap-4 relative z-10">
                <div className="relative">
                  <div className="w-20 h-20 rounded-full bg-white/20 border-2 border-white/40 flex items-center justify-center overflow-hidden">
                    {avatarUrl ? (
                      <img src={avatarUrl} alt="avatar" className="w-full h-full object-cover" />
                    ) : (
                      <User className="w-10 h-10 text-white" />
                    )}
                  </div>
                  <div className="absolute -bottom-1 -right-1 bg-accent text-white text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-0.5 shadow-soft">
                    <Star className="w-3 h-3 fill-current" />
                    {rating}
                  </div>
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-0.5">
                    <h2 className="text-2xl font-extrabold text-white">
                      {(profile?.completed_tasks || 0) >= 100 ? "🏆 Platino" :
                       (profile?.completed_tasks || 0) >= 50  ? "🥇 Oro" :
                       (profile?.completed_tasks || 0) >= 20  ? "🥈 Plata" : "🥉 Básico"}
                    </h2>
                  </div>
                  <p className="text-sm text-white/70">{count} calificaciones · {profile?.completed_tasks || 0} servicios</p>
                </div>
              </div>

              {/* Progress bar */}
              {(() => {
                const done = profile?.completed_tasks || 0;
                const tiers = [
                  { name: "Plata",   min: 0,  max: 20  },
                  { name: "Oro",     min: 20, max: 50  },
                  { name: "Platino", min: 50, max: 100 },
                ];
                const current = tiers.find((t) => done < t.max) ?? tiers[tiers.length - 1];
                const pct = Math.min(100, Math.round(((done - current.min) / (current.max - current.min)) * 100));
                const remaining = Math.max(0, current.max - done);
                return (
                  <div className="mt-5 relative z-10">
                    <div className="flex justify-between text-xs text-white/70 mb-1.5">
                      <span>{remaining > 0 ? `${remaining} tareas para ${current.name}` : "¡Nivel máximo!"}</span>
                      <span>{pct}%</span>
                    </div>
                    <div className="w-full h-2.5 bg-white/20 rounded-full overflow-hidden">
                      <div className="h-full bg-white rounded-full transition-all duration-700" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Earnings section */}
            <div className="px-5 mt-5">
              <p className="text-sm font-bold text-foreground mb-3">Mis ingresos</p>

              {/* Period tabs */}
              <div className="flex gap-1 bg-secondary rounded-xl p-1 mb-4">
                {([
                  { key: "day",   label: "Hoy" },
                  { key: "week",  label: "Semana" },
                  { key: "month", label: "Mes" },
                ] as const).map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => setEarningsTab(key)}
                    className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-all ${
                      earningsTab === key ? "bg-primary text-white shadow-soft" : "text-muted-foreground"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Earnings amount */}
              <div className="bg-card rounded-2xl border border-border p-5 mb-4 shadow-soft">
                <p className="text-xs text-muted-foreground mb-1">
                  {earningsTab === "day" ? "Ingresos de hoy" : earningsTab === "week" ? "Ingresos esta semana" : "Ingresos este mes"}
                </p>
                <p className="text-4xl font-extrabold text-foreground mb-1">
                  COL${(earningsTab === "day" ? todayEarnings : earningsTab === "week" ? weekEarnings : monthEarnings).toLocaleString("es-CO")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {profile?.completed_tasks || 0} servicios completados en total
                </p>
              </div>

              {/* Stats row */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-card rounded-2xl border border-border p-4 text-center shadow-soft">
                  <p className="text-2xl font-extrabold text-primary">{profile?.completed_tasks || 0}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">Servicios</p>
                </div>
                <div className="bg-card rounded-2xl border border-border p-4 text-center shadow-soft">
                  <p className="text-2xl font-extrabold text-accent">{rating}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">Calificación</p>
                </div>
                <div className="bg-card rounded-2xl border border-border p-4 text-center shadow-soft">
                  <p className="text-2xl font-extrabold text-foreground">{count}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">Reseñas</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "cartera" && (
          <div className="pb-6">
            {/* Balance hero */}
            <div className="bg-brand-gradient px-5 pt-6 pb-8 relative overflow-hidden">
              <div className="absolute -top-8 -right-8 w-36 h-36 rounded-full bg-white/10" />
              <p className="text-sm text-white/70 mb-1 relative z-10">Saldo disponible</p>
              <p className="text-4xl font-extrabold text-white relative z-10">
                COL${(profile?.credits || 0).toLocaleString("es-CO")}
              </p>
            </div>

            <div className="px-5 mt-5 space-y-4">
              {/* Low balance warning */}
              {(profile?.credits || 0) < 2000 && (
                <div className="flex items-start gap-3 p-4 rounded-2xl bg-amber-50 border border-amber-200">
                  <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-bold text-amber-700">Saldo bajo</p>
                    <p className="text-xs text-amber-600 mt-0.5">
                      Recarga para seguir aceptando tareas.
                    </p>
                  </div>
                </div>
              )}

              {/* How it works */}
              <div className="bg-card rounded-2xl border border-border p-4">
                <p className="text-sm font-bold text-foreground mb-3">¿Cómo funciona?</p>
                <div className="space-y-2.5">
                  {[
                    { icon: "🎁", text: "Al registrarte recibes COL$5,000 de bienvenida" },
                    { icon: "💸", text: "Por cada tarea completada se descuenta un pequeño porcentaje, para mantenernos operando" },
                    { icon: "📲", text: "Recarga cuando necesites más saldo, para seguir aceptando tareas" },
                  ].map((item, i) => (
                    <div key={i} className="flex items-start gap-3">
                      <span className="text-lg">{item.icon}</span>
                      <p className="text-xs text-muted-foreground leading-relaxed">{item.text}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Recharge button */}
              <button
                onClick={() => setShowRecharge(true)}
                className="w-full py-4 rounded-2xl bg-accent-gradient text-white font-bold text-base active:scale-[0.98] transition-all shadow-elevated flex items-center justify-center gap-2"
              >
                <Wallet className="w-5 h-5" />
                Recargar saldo
              </button>

              {/* Recharge history */}
              {rechargeHistory.length > 0 && (
                <div>
                  <p className="text-sm font-bold text-foreground mb-3">Historial de recargas</p>
                  <div className="bg-card rounded-2xl border border-border overflow-hidden">
                    {rechargeHistory.map((r, i) => {
                      const statusIcon = r.status === "approved" ? CheckCircle2 : r.status === "rejected" ? XCircle : Clock;
                      const statusColor = r.status === "approved" ? "text-green-600" : r.status === "rejected" ? "text-destructive" : "text-amber-600";
                      const statusLabel = r.status === "approved" ? "Aprobada" : r.status === "rejected" ? "Rechazada" : "En revisión";
                      const Icon = statusIcon;
                      return (
                        <div key={r.id} className={`flex items-center gap-3 px-4 py-3.5 ${i < rechargeHistory.length - 1 ? "border-b border-border" : ""}`}>
                          <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${r.status === "approved" ? "bg-green-50" : r.status === "rejected" ? "bg-destructive/10" : "bg-amber-50"}`}>
                            <Icon className={`w-4.5 h-4.5 ${statusColor}`} />
                          </div>
                          <div className="flex-1">
                            <p className="text-sm font-semibold text-foreground">COL${Number(r.amount).toLocaleString("es-CO")}</p>
                            <p className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleDateString("es-CO")}</p>
                          </div>
                          <span className={`text-xs font-bold ${statusColor}`}>{statusLabel}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Recharge modal */}
            {showRecharge && (
              <div className="fixed inset-0 z-[300] bg-black/60 flex items-end">
                <div className="w-full bg-card rounded-t-3xl p-6 pb-10 animate-slide-up">
                  <h3 className="text-lg font-extrabold text-foreground mb-1">Recargar saldo</h3>
                  <p className="text-xs text-muted-foreground mb-5">
                    Transfiere a nuestra cuenta y sube el comprobante. Acreditamos en menos de 24h.
                  </p>

                  {/* Payment info */}
                  <div className="bg-primary/5 rounded-2xl p-4 mb-5 space-y-2">
                    <p className="text-xs font-bold text-foreground">Datos de pago</p>
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Nequi</span>
                      <span className="font-semibold text-foreground">3126633920</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Titular</span>
                      <span className="font-semibold text-foreground">Cristian Martínez</span>
                    </div>
                  </div>

                  {/* Amount */}
                  <label className="text-xs font-semibold text-foreground mb-2 block">Monto a recargar (COP)</label>
                  <div className="relative mb-4">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-accent font-bold">$</span>
                    <input
                      type="number"
                      value={rechargeAmount}
                      onChange={(e) => setRechargeAmount(e.target.value)}
                      placeholder="10000"
                      className="w-full pl-10 pr-4 py-3.5 rounded-xl bg-secondary border border-border text-foreground text-lg font-bold focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </div>

                  {/* Quick amounts */}
                  <div className="flex gap-2 mb-5">
                    {[5000, 10000, 20000, 50000].map((amt) => (
                      <button
                        key={amt}
                        onClick={() => setRechargeAmount(String(amt))}
                        className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${rechargeAmount === String(amt) ? "bg-primary text-white" : "bg-secondary text-muted-foreground"}`}
                      >
                        ${(amt / 1000).toFixed(0)}k
                      </button>
                    ))}
                  </div>

                  {/* Receipt upload */}
                  <label className="text-xs font-semibold text-foreground mb-2 block">Comprobante de pago</label>
                  <input ref={rechargeFileRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => setRechargeFile(e.target.files?.[0] || null)} />
                  {rechargeFile ? (
                    <div className="flex items-center gap-3 p-3 rounded-xl bg-primary/5 border border-primary/20 mb-5">
                      <CheckCircle2 className="w-5 h-5 text-primary shrink-0" />
                      <p className="text-sm font-semibold text-foreground flex-1 truncate">{rechargeFile.name}</p>
                      <button onClick={() => setRechargeFile(null)} className="text-muted-foreground text-lg">✕</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => rechargeFileRef.current?.click()}
                      className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl border-2 border-dashed border-border bg-secondary mb-5 text-sm font-semibold text-muted-foreground"
                    >
                      <Upload className="w-4 h-4" />
                      Subir comprobante (foto o PDF)
                    </button>
                  )}

                  <div className="flex gap-3">
                    <button onClick={() => { setShowRecharge(false); setRechargeAmount(""); setRechargeFile(null); }} className="flex-1 py-3.5 rounded-2xl border-2 border-border text-foreground font-bold text-sm">
                      Cancelar
                    </button>
                    <button
                      onClick={handleSubmitRecharge}
                      disabled={!rechargeAmount || parseFloat(rechargeAmount) <= 0 || submittingRecharge}
                      className="flex-1 py-3.5 rounded-2xl bg-brand-gradient text-white font-bold text-sm disabled:opacity-60"
                    >
                      {submittingRecharge ? "Enviando..." : "Enviar solicitud"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom tab bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-card border-t border-border z-20">
        <div className="flex items-center justify-around py-2 pb-6">
          {([
            { tab: "solicitudes", icon: ListOrdered, label: "Solicitudes" },
            { tab: "desempeno", icon: LayoutGrid, label: "Desempeño" },
            { tab: "cartera", icon: Wallet, label: "Cartera" },
          ] as const).map(({ tab, icon: Icon, label }) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex flex-col items-center gap-1 px-4 py-1 transition-colors ${
                activeTab === tab ? "text-primary" : "text-muted-foreground"
              }`}
            >
              <Icon className={`w-5 h-5 ${activeTab === tab ? "stroke-[2.5]" : ""}`} />
              <span className={`text-[11px] ${activeTab === tab ? "font-bold" : "font-medium"}`}>{label}</span>
              {activeTab === tab && <div className="w-1 h-1 rounded-full bg-primary" />}
            </button>
          ))}
        </div>
      </div>

      <SidebarMenu open={sidebarOpen} onClose={() => setSidebarOpen(false)} onNavigate={onSidebarNavigate} onSwitchMode={onSwitchMode} />
    </div>
  );
};

export default TaskerView;
