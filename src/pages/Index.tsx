import { useState, useEffect, useCallback } from "react";
import { Menu, Navigation, ArrowRight } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import MapView from "../components/MapView";
import BottomSheet from "../components/BottomSheet";
import ServiceForm from "../components/ServiceForm";
import TaskerView from "../components/TaskerView";
import WaitingOffers from "../components/WaitingOffers";
import OfferCard, { Offer } from "../components/OfferCard";
import DealDone from "../components/DealDone";
import ActiveTaskScreen from "../components/ActiveTaskScreen";
import PaymentScreen from "../components/PaymentScreen";
import RatingFlow from "../components/RatingFlow";
import SidebarMenu, { SidebarScreen } from "../components/SidebarMenu";
import TaskerRegistration from "../components/TaskerRegistration";
import HistoryScreen from "../components/HistoryScreen";
import NotificationsScreen from "../components/NotificationsScreen";
import SecurityScreen from "../components/SecurityScreen";
import SettingsScreen from "../components/SettingsScreen";
import HelpScreen from "../components/HelpScreen";

type Screen = "home" | "form" | "waiting" | "deal" | "chat" | "completion" | "rating" | "cancelled";

const Index = () => {
  const { activeRole, roles, switchRole, user } = useAuth();
  const [screen, setScreen] = useState<Screen>("home");
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [publishedTask, setPublishedTask] = useState<{ id: string; title: string; description: string; price: number; category: string; tasker_id?: string; location_address?: string | null; location_lat?: number | null; location_lng?: number | null } | null>(null);
  const [liveOffers, setLiveOffers] = useState<Offer[]>([]);
  const [acceptedOffer, setAcceptedOffer] = useState<Offer | null>(null);
  const [sidebarScreen, setSidebarScreen] = useState<SidebarScreen>(null);
  const [showTaskerRegistration, setShowTaskerRegistration] = useState(false);

  const isTasker = activeRole === "tasker";

  // On mount, check if client has an active task and restore state
  useEffect(() => {
    if (!user || isTasker) return;
    const checkActiveTask = async () => {
      const { data: task } = await supabase
        .from("tasks")
        .select("*")
        .eq("client_id", user.id)
        .in("status", ["open", "accepted", "in_progress"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!task) return;

      const taskData = {
        id: task.id,
        title: task.title,
        description: task.description || "",
        price: Number(task.price),
        category: task.category,
        location_address: (task as any).location_address ?? null,
        location_lat: (task as any).location_lat ?? null,
        location_lng: (task as any).location_lng ?? null,
      };

      if (task.status === "open") {
        setPublishedTask(taskData);
        setScreen("waiting");
        setSheetExpanded(true);
      } else if (task.status === "accepted" || task.status === "in_progress" || task.status === "completed") {
        const { data: offer } = await supabase
          .from("offers")
          .select("*")
          .eq("id", task.accepted_offer_id)
          .single();
        if (offer) {
          const { data: prof } = await supabase
            .from("profiles")
            .select("full_name")
            .eq("user_id", offer.tasker_id)
            .single();
          const acceptedOffer: Offer = {
            id: offer.id,
            name: prof?.full_name || "Tasker",
            photo: "",
            rating: 5,
            completedTasks: 0,
            price: Number(offer.price),
          };
          setPublishedTask({ ...taskData, tasker_id: offer.tasker_id });
          setAcceptedOffer(acceptedOffer);
          // If already completed, go straight to payment
          setScreen(task.status === "completed" ? "completion" : "chat");
        }
      }
    };
    checkActiveTask();
  }, [user, isTasker]);

  // Reset on role change
  useEffect(() => {
    setScreen("home");
    setSheetExpanded(false);
    setPublishedTask(null);
    setLiveOffers([]);
    setAcceptedOffer(null);
    setSidebarOpen(false);
    setSidebarScreen(null);
  }, [activeRole]);

  // Subscribe to real offers when waiting
  useEffect(() => {
    if (screen !== "waiting" || !publishedTask) return;

    // Load existing offers first
    const loadOffers = async () => {
      const { data } = await supabase
        .from("offers")
        .select("*")
        .eq("task_id", publishedTask.id)
        .eq("status", "pending");

      if (data) {
        const offers = await Promise.all(data.map(offerRowToOffer));
        setLiveOffers(offers);
      }
    };
    loadOffers();

    // Realtime subscription
    const channel = supabase
      .channel(`offers:${publishedTask.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "offers", filter: `task_id=eq.${publishedTask.id}` },
        async (payload) => {
          const newOffer = await offerRowToOffer(payload.new);
          setLiveOffers((prev) => {
            if (prev.find((o) => o.id === newOffer.id)) return prev;
            return [...prev, newOffer];
          });
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [screen, publishedTask]);

  // Poll for task completion or cancellation (client side)
  useEffect(() => {
    if (!publishedTask?.id || screen !== "chat") return;
    const taskId = publishedTask.id;
    const interval = setInterval(async () => {
      const { data } = await supabase
        .from("tasks")
        .select("status")
        .eq("id", taskId)
        .maybeSingle();
      if (!data) return; // query failed, retry next tick
      if (data.status === "completed") {
        clearInterval(interval);
        setScreen("completion");
      } else if (data.status === "cancelled") {
        clearInterval(interval);
        setScreen("cancelled" as any);
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [publishedTask?.id, screen]);

  const offerRowToOffer = async (row: any): Promise<Offer> => {
    // Fetch tasker profile for rating and completed_tasks
    const { data: prof } = await supabase
      .from("profiles")
      .select("full_name, completed_tasks")
      .eq("user_id", row.tasker_id)
      .single();

    // Fetch rating (last 40)
    const { data: ratings } = await supabase
      .from("ratings" as any)
      .select("score")
      .eq("rated_id", row.tasker_id)
      .order("created_at", { ascending: false })
      .limit(40);

    const avgRating = ratings && ratings.length > 0
      ? Math.round((ratings as any[]).reduce((s, r) => s + r.score, 0) / ratings.length * 10) / 10
      : 5.0;

    return {
      id: row.id,
      name: prof?.full_name || "Tasker",
      photo: "",
      rating: avgRating,
      completedTasks: prof?.completed_tasks || 0,
      price: row.price,
      message: row.message ?? undefined,
    };
  };

  const handlePublish = useCallback(async (task: { title: string; description: string; price: number; category: string; location_address: string; location_lat?: number; location_lng?: number }) => {
    if (!user) return;
    const { data, error } = await supabase
      .from("tasks")
      .insert({
        client_id: user.id,
        title: task.title,
        description: task.description,
        price: task.price,
        category: task.category,
        status: "open",
        location_address: task.location_address,
        location_lat: task.location_lat,
        location_lng: task.location_lng,
      })
      .select()
      .single();

    if (error || !data) {
      console.error("Error publishing task:", error);
      return;
    }

    setPublishedTask({ id: data.id, title: task.title, description: task.description, price: task.price, category: task.category, location_address: task.location_address, location_lat: task.location_lat, location_lng: task.location_lng });
    setScreen("waiting");
    setSheetExpanded(true);
  }, [user]);

  const handleAccept = useCallback(async (offer: Offer) => {
    if (!publishedTask) return;
    // Update task status and accepted offer
    await supabase
      .from("tasks")
      .update({ status: "accepted", accepted_offer_id: offer.id })
      .eq("id", publishedTask.id);

    // Update offer status
    await supabase
      .from("offers")
      .update({ status: "accepted" })
      .eq("id", offer.id);

    // Reject other pending offers
    await supabase
      .from("offers")
      .update({ status: "rejected" })
      .eq("task_id", publishedTask.id)
      .neq("id", offer.id);

    setAcceptedOffer(offer);
    // Get tasker_id and phone from offer to pass to map and chat
    const { data: offerData } = await supabase.from("offers").select("tasker_id").eq("id", offer.id).single();
    if (offerData) {
      // Also fetch tasker phone for the call button in chat
      const { data: taskerProf } = await supabase
        .from("profiles")
        .select("phone")
        .eq("user_id", offerData.tasker_id)
        .single();
      setPublishedTask((prev) => prev ? {
        ...prev,
        tasker_id: offerData.tasker_id,
        taskerPhone: taskerProf?.phone ?? null,
      } : prev);
    }
    setScreen("deal");
  }, [publishedTask]);

  const handleReject = useCallback(async (offerId: string) => {
    await supabase.from("offers").update({ status: "rejected" }).eq("id", offerId);
    setLiveOffers((prev) => prev.filter((o) => o.id !== offerId));
  }, []);

  const handleCancel = useCallback(async () => {
    if (publishedTask) {
      // Only cancel if the task is not already completed
      const { data: current } = await supabase
        .from("tasks")
        .select("status")
        .eq("id", publishedTask.id)
        .maybeSingle();
      if (current && current.status !== "completed") {
        await supabase.from("tasks").update({ status: "cancelled" }).eq("id", publishedTask.id);
      }
    }
    setScreen("home");
    setSheetExpanded(false);
    setPublishedTask(null);
    setLiveOffers([]);
  }, [publishedTask]);

  const handleSwitchMode = () => {
    if (activeRole === "tasker") {
      switchRole("client");
    } else {
      if (roles.includes("tasker")) {
        switchRole("tasker");
      } else {
        setShowTaskerRegistration(true);
      }
    }
  };

  if (showTaskerRegistration) {
    return <TaskerRegistration onBack={() => setShowTaskerRegistration(false)} onComplete={() => setShowTaskerRegistration(false)} />;
  }

  if (sidebarScreen === "history") return <HistoryScreen onBack={() => setSidebarScreen(null)} />;
  if (sidebarScreen === "notifications") return <NotificationsScreen onBack={() => setSidebarScreen(null)} />;
  if (sidebarScreen === "security") return <SecurityScreen onBack={() => setSidebarScreen(null)} />;
  if (sidebarScreen === "settings") return <SettingsScreen onBack={() => setSidebarScreen(null)} />;
  if (sidebarScreen === "help") return <HelpScreen onBack={() => setSidebarScreen(null)} />;

  if (screen === "deal" && acceptedOffer) {
    return <DealDone offer={acceptedOffer} onContinue={() => setScreen("chat")} />;
  }

  if (screen === "cancelled") {
    return (
      <div className="fixed inset-0 z-50 bg-background flex flex-col items-center justify-center px-8 text-center gap-4 animate-fade-in">
        <div className="w-20 h-20 rounded-full bg-destructive/10 flex items-center justify-center">
          <span className="text-4xl">😔</span>
        </div>
        <h2 className="text-xl font-extrabold text-foreground">Servicio cancelado</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Has cancelado este servicio. Recuerda que las cancelaciones frecuentes pueden afectar tu reputación en la plataforma.
        </p>
        <button
          onClick={handleCancel}
          className="mt-2 px-8 py-4 rounded-2xl bg-brand-gradient text-white font-bold text-base shadow-elevated active:scale-[0.98] transition-all"
        >
          Entendido
        </button>
      </div>
    );
  }
  if (screen === "chat" && acceptedOffer && publishedTask) {
    return (
      <ActiveTaskScreen
        task={{
          id: publishedTask.id,
          title: publishedTask.title,
          description: publishedTask.description,
          price: acceptedOffer.price,
          category: publishedTask.category,
          clientName: acceptedOffer.name,
          client_id: user?.id || "",
          tasker_id: publishedTask.tasker_id,
          taskerName: acceptedOffer.name,
          otherUserPhone: (publishedTask as any).taskerPhone ?? null,
          location_address: (publishedTask as any).location_address ?? null,
          location_lat: (publishedTask as any).location_lat ?? null,
          location_lng: (publishedTask as any).location_lng ?? null,
          offerId: acceptedOffer.id,
        }}
        onDone={() => setScreen("completion")}
        onCancel={handleCancel}
      />
    );
  }
  if (screen === "completion" && acceptedOffer && publishedTask) {
    return (
      <PaymentScreen
        taskId={publishedTask.id}
        taskTitle={publishedTask.title}
        price={acceptedOffer.price}
        taskerName={acceptedOffer.name}
        onDone={() => setScreen("rating")}
      />
    );
  }
  if (screen === "rating" && acceptedOffer && publishedTask) {
    return (
      <RatingFlow
        taskId={publishedTask.id}
        targetUserId={publishedTask.tasker_id || ""}
        targetName={acceptedOffer.name}
        role="client"
        onDone={handleCancel}
      />
    );
  }

  if (isTasker) {
    return <TaskerView onBack={() => {}} onSidebarNavigate={setSidebarScreen} onSwitchMode={handleSwitchMode} />;
  }

  const hasActiveTask = screen === "waiting" || screen === "deal" || screen === "chat" || screen === "completion" || screen === "rating";

  return (
    <div className="relative h-screen w-full overflow-hidden bg-background">
      <div className="absolute inset-0 z-0">
        <MapView />
      </div>

      {/* Only show menu/nav buttons when no active task */}
      {!hasActiveTask && (
        <button
          onClick={() => setSidebarOpen(true)}
          className="absolute top-12 left-4 z-10 w-11 h-11 rounded-full bg-card shadow-medium flex items-center justify-center active:scale-95 transition-transform border border-border"
        >
          <Menu className="w-5 h-5 text-primary" />
        </button>
      )}

      <button
        className="absolute right-4 z-10 w-11 h-11 rounded-full bg-primary shadow-elevated flex items-center justify-center active:scale-95 transition-transform"
        style={{ bottom: sheetExpanded || screen === "form" || screen === "waiting" ? "88vh" : "300px" }}
      >
        <Navigation className="w-5 h-5 text-white" />
      </button>

      {!hasActiveTask && (
        <SidebarMenu
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          onNavigate={setSidebarScreen}
          onSwitchMode={handleSwitchMode}
        />
      )}

      <BottomSheet
        expanded={sheetExpanded || screen === "form" || screen === "waiting"}
        onToggle={() => {
          if (hasActiveTask) return; // Can't close during active task
          if (screen === "form") { setScreen("home"); setSheetExpanded(false); }
          else setSheetExpanded(!sheetExpanded);
        }}
      >
        {screen === "waiting" && publishedTask ? (
          <div>
            <WaitingOffers taskTitle={publishedTask.title} taskPrice={publishedTask.price} offersCount={liveOffers.length} onCancel={handleCancel} />
            {liveOffers.length > 0 && (
              <div className="mt-4 space-y-3">
                <h3 className="text-sm font-semibold text-foreground">Ofertas recibidas</h3>
                {liveOffers.map((offer, i) => (
                  <OfferCard key={offer.id} offer={offer} onAccept={handleAccept} onReject={handleReject} isNew={i === liveOffers.length - 1} />
                ))}
              </div>
            )}
          </div>
        ) : screen === "form" ? (
          <ServiceForm onSubmit={handlePublish} onBack={() => { setScreen("home"); setSheetExpanded(false); }} />
        ) : (
          <div className="animate-fade-in">
            <div className="flex gap-3 overflow-x-auto pb-4 -mx-1 px-1 scrollbar-hide">
              {[
                { emoji: "🛒", label: "Mandados" },
                { emoji: "🧍", label: "Filas" },
                { emoji: "📋", label: "Trámites" },
                { emoji: "📦", label: "Entregas" },
                { emoji: "🛍️", label: "Compras" },
              ].map((cat) => (
                <button
                  key={cat.label}
                  onClick={() => setScreen("form")}
                  className="flex flex-col items-center gap-1.5 min-w-[68px] py-2.5 px-3 rounded-2xl bg-primary/8 border border-primary/15 hover:bg-primary/15 transition-all active:scale-95"
                >
                  <span className="text-2xl">{cat.emoji}</span>
                  <span className="text-[11px] font-semibold text-primary whitespace-nowrap">{cat.label}</span>
                </button>
              ))}
            </div>

            <button
              onClick={() => setScreen("form")}
              className="w-full py-4 px-4 rounded-2xl bg-secondary text-left flex items-center gap-3 shadow-soft active:scale-[0.98] transition-all mb-3 border border-border"
            >
              <span className="text-muted-foreground text-base">🔍</span>
              <span className="text-muted-foreground text-[15px]">¿Qué necesitas hoy?</span>
            </button>

            <button
              onClick={() => setScreen("form")}
              className="w-full py-4 rounded-2xl bg-brand-gradient text-white font-bold text-base shadow-elevated flex items-center justify-center gap-2 active:scale-[0.98] transition-all"
            >
              Pedir un servicio
              <ArrowRight className="w-5 h-5" />
            </button>
          </div>
        )}
      </BottomSheet>
    </div>
  );
};

export default Index;
