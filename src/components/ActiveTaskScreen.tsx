import { useEffect, useRef, useState, useCallback } from "react";
import { MessageCircle, XCircle, MapPin, Navigation, CheckCircle, ExternalLink } from "lucide-react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import SimulatedChat from "./SimulatedChat";
import RatingFlow from "./RatingFlow";
import { Offer } from "./OfferCard";

const OSM_TILE = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

interface ActiveTask {
  id: string;
  title: string;
  description: string | null;
  price: number;
  category: string;
  clientName: string;
  client_id: string;
  tasker_id?: string;
  taskerName?: string;
  otherUserPhone?: string | null;
  location_address: string | null;
  location_lat: number | null;
  location_lng: number | null;
  offerId: string;
}

interface ActiveTaskScreenProps {
  task: ActiveTask;
  onDone: () => void;
  onCancel?: () => void;
}

const taskerIcon = new L.DivIcon({
  html: `<div style="width:18px;height:18px;border-radius:50%;background:#1E9FE8;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.35);"></div>`,
  className: "",
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

const destIcon = new L.DivIcon({
  html: `<div style="width:30px;height:30px;border-radius:50%;background:#F47920;border:3px solid white;box-shadow:0 2px 10px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="white"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
  </div>`,
  className: "",
  iconSize: [30, 30],
  iconAnchor: [15, 30],
});

const ActiveTaskScreen = ({ task, onDone, onCancel }: ActiveTaskScreenProps) => {
  const { user } = useAuth();
  const mapRef = useRef<L.Map | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const taskerMarkerRef = useRef<L.Marker | null>(null);
  const routeLayerRef = useRef<L.Polyline | null>(null);
  const [showChat, setShowChat] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [showRating, setShowRating] = useState(false);
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [checkingReceipt, setCheckingReceipt] = useState(false);
  const [taskCancelledByClient, setTaskCancelledByClient] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const isTasker = user?.id !== task.client_id;

  const drawRoute = useCallback(async (fromLat: number, fromLng: number) => {
    if (!task.location_lat || !task.location_lng || !mapRef.current) return;
    try {
      const res = await fetch(
        `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${task.location_lng},${task.location_lat}?overview=full&geometries=geojson`
      );
      const data = await res.json();
      if (data.routes?.[0]) {
        const coords: [number, number][] = data.routes[0].geometry.coordinates.map(
          ([lng, lat]: [number, number]) => [lat, lng]
        );
        if (routeLayerRef.current) {
          routeLayerRef.current.setLatLngs(coords);
        } else {
          routeLayerRef.current = L.polyline(coords, {
            color: "#1E9FE8",
            weight: 5,
            opacity: 0.8,
          }).addTo(mapRef.current);
        }
      }
    } catch { /* silent fail */ }
  }, [task.location_lat, task.location_lng]);

  // Initialize map — runs once, never destroyed while component is mounted.
  // The map container div stays in the DOM at all times; chat/rating/receipt
  // are rendered as fixed overlays so Leaflet never loses its container.
  useEffect(() => {
    if (!containerRef.current) return;

    if (mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
    }
    containerRef.current.innerHTML = "";

    const center: [number, number] = task.location_lat && task.location_lng
      ? [task.location_lat, task.location_lng]
      : [1.2136, -77.2811];

    const map = L.map(containerRef.current, {
      center,
      zoom: 15,
      zoomControl: false,
      attributionControl: false,
    });

    L.tileLayer(OSM_TILE, { maxZoom: 19, crossOrigin: true }).addTo(map);

    if (task.location_lat && task.location_lng) {
      L.marker([task.location_lat, task.location_lng], { icon: destIcon })
        .addTo(map)
        .bindPopup(task.location_address || "Destino del servicio");
    }

    mapRef.current = map;

    // Multiple invalidateSize calls — Android WebView layout can be slow
    setTimeout(() => map.invalidateSize(), 150);
    setTimeout(() => map.invalidateSize(), 500);
    setTimeout(() => map.invalidateSize(), 1000);

    return () => {
      map.remove();
      mapRef.current = null;
      taskerMarkerRef.current = null;
      routeLayerRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // TASKER: publish own GPS location + draw route
  useEffect(() => {
    if (!isTasker || !user) return;
    let watchId: number;

    const publish = async (lat: number, lng: number) => {
      await supabase.from("tasker_locations" as any).upsert({
        tasker_id: user.id,
        lat,
        lng,
        updated_at: new Date().toISOString(),
      });
    };

    if (navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(
        async (pos) => {
          const { latitude: lat, longitude: lng } = pos.coords;
          const latlng: [number, number] = [lat, lng];
          if (taskerMarkerRef.current) {
            taskerMarkerRef.current.setLatLng(latlng);
          } else if (mapRef.current) {
            taskerMarkerRef.current = L.marker(latlng, { icon: taskerIcon })
              .addTo(mapRef.current)
              .bindPopup("Tu ubicación");
          }
          await publish(lat, lng);
          await drawRoute(lat, lng);
        },
        undefined,
        { enableHighAccuracy: true, maximumAge: 5000 }
      );
    }

    return () => {
      if (watchId) navigator.geolocation.clearWatch(watchId);
    };
  }, [isTasker, user, drawRoute]);

  const clientCenteredRef = useRef(false); // fitBounds only once on client side

  // CLIENT: subscribe to tasker real-time location
  useEffect(() => {
    if (isTasker || !task.tasker_id) return;

    const loadInitial = async () => {
      const { data } = await supabase
        .from("tasker_locations" as any)
        .select("lat, lng")
        .eq("tasker_id", task.tasker_id)
        .maybeSingle();
      if (data && mapRef.current) {
        const latlng: [number, number] = [(data as any).lat, (data as any).lng];
        if (taskerMarkerRef.current) {
          taskerMarkerRef.current.setLatLng(latlng);
        } else {
          taskerMarkerRef.current = L.marker(latlng, { icon: taskerIcon })
            .addTo(mapRef.current)
            .bindPopup("Tasker en camino");
        }
      }
    };
    loadInitial();

    const channel = supabase
      .channel(`tasker-loc-${task.tasker_id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tasker_locations", filter: `tasker_id=eq.${task.tasker_id}` },
        (payload) => {
          const { lat, lng } = payload.new as any;
          if (!lat || !lng) return;
          const latlng: [number, number] = [lat, lng];
          if (taskerMarkerRef.current) {
            taskerMarkerRef.current.setLatLng(latlng);
          } else if (mapRef.current) {
            taskerMarkerRef.current = L.marker(latlng, { icon: taskerIcon })
              .addTo(mapRef.current)
              .bindPopup("Tasker en camino");
          }
          // Only fit bounds on first update — let user pan freely after that
          if (!clientCenteredRef.current && mapRef.current && task.location_lat && task.location_lng) {
            const bounds = L.latLngBounds([latlng, [task.location_lat, task.location_lng]]);
            mapRef.current.fitBounds(bounds, { padding: [60, 60] });
            clientCenteredRef.current = true;
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [isTasker, task.tasker_id, task.location_lat, task.location_lng]);

  // Poll for cancellation by client (tasker side)
  useEffect(() => {
    if (!isTasker || !task.id) return;
    const interval = setInterval(async () => {
      const { data } = await supabase
        .from("tasks")
        .select("status")
        .eq("id", task.id)
        .maybeSingle();
      if (data?.status === "cancelled") {
        clearInterval(interval);
        setTaskCancelledByClient(true);
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [isTasker, task.id]);

  const handleCancel = async () => {
    setCancelling(true);
    setShowCancelConfirm(false);
    if (isTasker) {
      await supabase.from("tasker_locations" as any).delete().eq("tasker_id", user?.id);
    }
    await supabase.from("offers").update({ status: "rejected" }).eq("id", task.offerId);
    await supabase.from("tasks").update({ status: "cancelled" }).eq("id", task.id);
    const otherUserId = isTasker ? task.client_id : task.tasker_id;
    if (otherUserId) {
      const cancellerRole = isTasker ? "El Tasker" : "El Cliente";
      await supabase.from("notifications" as any).insert({
        user_id: otherUserId,
        title: "Servicio cancelado",
        message: `${cancellerRole} ha cancelado el servicio "${task.title}".`,
      });
    }
    if (onCancel) onCancel(); else onDone();
  };

  const handleComplete = async () => {
    setCancelling(true);
    await supabase.from("tasker_locations" as any).delete().eq("tasker_id", user?.id);
    await supabase.from("tasks").update({ status: "completed" }).eq("id", task.id);
    await supabase.from("offers").update({ status: "accepted" }).eq("id", task.offerId);
    // Deduct 10% commission from tasker credits
    if (isTasker) {
      await supabase.rpc("deduct_task_commission" as any, {
        p_task_id: task.id,
        offer_price: task.price,
      });
    }
    setCheckingReceipt(true);
    const poll = setInterval(async () => {
      const { data } = await supabase
        .from("payment_receipts" as any)
        .select("receipt_path")
        .eq("task_id", task.id)
        .maybeSingle();
      if (data) {
        clearInterval(poll);
        const path = (data as any).receipt_path;
        const { data: signed } = await supabase.storage.from("receipts").createSignedUrl(path, 300);
        setReceiptUrl(signed?.signedUrl || supabase.storage.from("receipts").getPublicUrl(path).data.publicUrl);
        setCheckingReceipt(false);
      }
    }, 3000);
    setCancelling(false);
  };

  const chatOffer: Offer = {
    id: task.offerId,
    name: task.clientName,
    photo: "",
    rating: 5,
    completedTasks: 0,
    price: task.price,
  };

  // Any overlay active = hide the map layer completely
  const anyOverlay = showChat || showCancelConfirm || checkingReceipt || !!receiptUrl || showRating || taskCancelledByClient;

  // The map div is ALWAYS in the DOM. Everything else is a fixed overlay.
  return (
    <div className="fixed inset-0 z-40 bg-background flex flex-col">
      {/* Header — hidden when any overlay is open */}
      {!anyOverlay && (
      <div className="bg-brand-gradient px-4 pt-12 pb-4 relative overflow-hidden">
        <div className="absolute -top-6 -right-6 w-24 h-24 rounded-full bg-white/10" />
        <div className="flex items-center gap-3 relative z-10">
          <div className="w-9 h-9" />
          <div className="flex-1">
            <p className="text-xs text-white/70 font-medium">
              {isTasker ? "Tarea activa" : "Tasker en camino"}
            </p>
            <p className="text-base font-bold text-white leading-tight">{task.title}</p>
          </div>
          <p className="text-xl font-extrabold text-white">COL${Number(task.price).toLocaleString()}</p>
        </div>
      </div>
      )}

      {/* Map — hidden when any overlay is active so nothing bleeds through */}
      <div
        className="relative flex-1 min-h-0"
        style={{ display: anyOverlay ? "none" : undefined }}
      >
        <div ref={containerRef} style={{ width: "100%", height: "100%", minHeight: 200 }} />

        {task.location_lat && task.location_lng && (
          <div className="absolute top-3 right-3 z-[1000] flex flex-col gap-2">
            <button
              onClick={() => mapRef.current?.flyTo([task.location_lat!, task.location_lng!], 16)}
              className="w-10 h-10 rounded-full bg-card shadow-medium flex items-center justify-center"
            >
              <Navigation className="w-5 h-5 text-primary" />
            </button>
            {isTasker && (
              <button
                onClick={() => window.open(`https://www.google.com/maps/dir/?api=1&destination=${task.location_lat},${task.location_lng}&travelmode=driving`, "_blank")}
                className="w-10 h-10 rounded-full bg-card shadow-medium flex items-center justify-center"
              >
                <ExternalLink className="w-5 h-5 text-accent" />
              </button>
            )}
          </div>
        )}

        <div className="absolute bottom-3 left-3 z-[1000] bg-card/90 backdrop-blur rounded-xl px-3 py-2 flex flex-col gap-1 shadow-soft">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-primary border-2 border-white" />
            <span className="text-xs text-foreground font-medium">{isTasker ? "Tu posición" : "Tasker"}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-accent border-2 border-white" />
            <span className="text-xs text-foreground font-medium">Destino</span>
          </div>
          {isTasker && (
            <div className="flex items-center gap-2">
              <div className="w-3 h-1.5 rounded bg-primary" />
              <span className="text-xs text-foreground font-medium">Ruta</span>
            </div>
          )}
        </div>
      </div>

      {/* Bottom panel — hidden when any overlay is active */}
      {!anyOverlay && (
      <div className="bg-card rounded-t-3xl shadow-elevated px-5 pt-4 pb-8 space-y-3">
        {task.location_address && (
          <div className="flex items-start gap-3 p-3 rounded-2xl bg-primary/5 border border-primary/15">
            <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <MapPin className="w-5 h-5 text-primary" />
            </div>
            <div className="flex-1">
              <p className="text-xs text-muted-foreground font-medium">Dirección del servicio</p>
              <p className="text-sm font-semibold text-foreground mt-0.5">{task.location_address}</p>
            </div>
            {isTasker && (
              <button
                onClick={() => {
                  const dest = task.location_lat && task.location_lng
                    ? `${task.location_lat},${task.location_lng}`
                    : encodeURIComponent(task.location_address!);
                  window.open(`https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`, "_blank");
                }}
                className="w-9 h-9 rounded-xl bg-accent/10 flex items-center justify-center shrink-0"
              >
                <ExternalLink className="w-4 h-4 text-accent" />
              </button>
            )}
          </div>
        )}

        {task.description && (
          <div className="p-3 rounded-2xl bg-secondary border border-border">
            <p className="text-xs text-muted-foreground font-medium mb-1">Descripción</p>
            <p className="text-sm text-foreground">{task.description}</p>
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={() => setShowChat(true)}
            className="flex-1 py-3.5 rounded-2xl bg-brand-gradient text-white font-bold text-sm flex items-center justify-center gap-2 shadow-soft active:scale-[0.98] transition-all"
          >
            <MessageCircle className="w-5 h-5" />
            Chat
          </button>
          {isTasker && (
            <button
              onClick={handleComplete}
              disabled={cancelling}
              className="flex-1 py-3.5 rounded-2xl bg-green-500 text-white font-bold text-sm flex items-center justify-center gap-2 active:scale-[0.98] transition-all"
            >
              <CheckCircle className="w-5 h-5" />
              Tarea completa
            </button>
          )}
          <button
            onClick={() => setShowCancelConfirm(true)}
            disabled={cancelling}
            className="flex-1 py-3.5 rounded-2xl bg-destructive/10 text-destructive font-bold text-sm flex items-center justify-center gap-2 active:scale-[0.98] transition-all"
          >
            <XCircle className="w-5 h-5" />
            {cancelling ? "..." : "Cancelar"}
          </button>
        </div>
      </div>
      )}

      {/* ── OVERLAYS — map stays alive underneath all of these ── */}

      {showCancelConfirm && (
        <div className="fixed inset-0 z-[200] bg-black/60 flex items-end">
          <div className="w-full bg-card rounded-t-3xl p-6 pb-10 animate-slide-up">
            <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-4">
              <XCircle className="w-7 h-7 text-destructive" />
            </div>
            <h3 className="text-lg font-extrabold text-foreground text-center mb-2">¿Cancelar el servicio?</h3>
            <p className="text-sm text-muted-foreground text-center mb-6">
              {isTasker
                ? "Cancelar frecuentemente puede afectar tu reputación y calificación."
                : "Cancelar frecuentemente puede limitar tu acceso a taskers disponibles."}
            </p>
            <div className="flex gap-3">
              <button onClick={() => setShowCancelConfirm(false)} className="flex-1 py-3.5 rounded-2xl border-2 border-border text-foreground font-bold text-sm">
                Volver
              </button>
              <button onClick={handleCancel} disabled={cancelling} className="flex-1 py-3.5 rounded-2xl bg-destructive text-white font-bold text-sm disabled:opacity-60">
                {cancelling ? "Cancelando..." : "Sí, cancelar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showChat && (
        <SimulatedChat
          offer={chatOffer}
          taskTitle={task.title}
          taskId={task.id}
          otherUserPhone={task.otherUserPhone}
          onComplete={isTasker ? handleComplete : undefined}
          onBack={() => {
            setShowChat(false);
            setTimeout(() => mapRef.current?.invalidateSize(), 250);
          }}
        />
      )}

      {isTasker && checkingReceipt && (
        <div className="fixed inset-0 z-[300] bg-background flex flex-col items-center justify-center px-8 text-center gap-4">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
            <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
          <h2 className="text-lg font-bold text-foreground">Esperando comprobante</h2>
          <p className="text-sm text-muted-foreground">El cliente está subiendo el comprobante de pago...</p>
        </div>
      )}

      {isTasker && receiptUrl && (
        <div className="fixed inset-0 z-[300] bg-background flex flex-col">
          <div className="bg-brand-gradient px-5 pt-12 pb-5">
            <h1 className="text-xl font-extrabold text-white">Comprobante de Pago</h1>
            <p className="text-sm text-white/70">COL${task.price.toLocaleString("es-CO")}</p>
          </div>
          <div className="flex-1 p-4 overflow-auto">
            {receiptUrl.includes(".pdf") ? (
              <iframe src={receiptUrl} className="w-full h-full rounded-2xl" title="Comprobante" />
            ) : (
              <img src={receiptUrl} alt="Comprobante" className="w-full rounded-2xl object-contain" />
            )}
          </div>
          <div className="px-5 pb-8 pt-3 bg-card border-t border-border">
            <button onClick={() => setShowRating(true)} className="w-full py-4 rounded-2xl bg-brand-gradient text-white font-bold text-base active:scale-[0.98] transition-all">
              Confirmar pago y calificar
            </button>
          </div>
        </div>
      )}

      {showRating && (
        <div className="fixed inset-0 z-[300] bg-background">
          <RatingFlow
            taskId={task.id}
            targetUserId={isTasker ? task.client_id : (task.tasker_id || "")}
            targetName={isTasker ? task.clientName : (task.taskerName || "Tasker")}
            role={isTasker ? "tasker" : "client"}
            onDone={onDone}
          />
        </div>
      )}

      {taskCancelledByClient && (
        <div className="fixed inset-0 z-[300] bg-background flex flex-col items-center justify-center px-8 text-center gap-4 animate-fade-in">
          <div className="w-20 h-20 rounded-full bg-destructive/10 flex items-center justify-center">
            <span className="text-4xl">😔</span>
          </div>
          <h2 className="text-xl font-extrabold text-foreground">Servicio cancelado</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            El cliente ha cancelado este servicio. Lamentamos los inconvenientes.
          </p>
          <button onClick={onDone} className="mt-2 px-8 py-4 rounded-2xl bg-brand-gradient text-white font-bold text-base shadow-elevated active:scale-[0.98] transition-all">
            Entendido
          </button>
        </div>
      )}
    </div>
  );
};

export default ActiveTaskScreen;
