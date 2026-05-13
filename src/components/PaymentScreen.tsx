import { useState, useRef } from "react";
import { Upload, CheckCircle2, Camera, FileText, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

interface PaymentScreenProps {
  taskId: string;
  taskTitle: string;
  price: number;
  taskerName: string;
  onDone: () => void;
}

const PaymentScreen = ({ taskId, taskTitle, price, taskerName, onDone }: PaymentScreenProps) => {
  const { user } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleUpload = async () => {
    if (!file || !user) return;
    setUploading(true);
    const ext = file.name.split(".").pop();
    const path = `${taskId}.${ext}`;
    const { error } = await supabase.storage.from("receipts").upload(path, file, { upsert: true });
    if (!error) {
      await supabase.from("payment_receipts" as any).upsert({
        task_id: taskId,
        client_id: user.id,
        receipt_path: path,
      });
      // Deduct credits from client and register tasker income
      await supabase.rpc("confirm_task_payment" as any, {
        p_task_id: taskId,
        p_client_id: user.id,
        p_amount: price,
      }).then(({ error: rpcErr }) => {
        if (rpcErr) console.warn("confirm_task_payment RPC error:", rpcErr.message);
      });
      setUploaded(true);
    }
    setUploading(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col">
      <div className="bg-brand-gradient px-5 pt-12 pb-5">
        <h1 className="text-xl font-extrabold text-white">Confirmar Pago</h1>
        <p className="text-sm text-white/70 mt-0.5">{taskTitle}</p>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-6 space-y-5">
        {/* Amount */}
        <div className="bg-card rounded-2xl border border-border p-5 text-center shadow-soft">
          <p className="text-xs text-muted-foreground mb-1">Total a pagar a {taskerName}</p>
          <p className="text-4xl font-extrabold text-foreground">COL${price.toLocaleString("es-CO")}</p>
        </div>

        {/* Payment methods */}
        <div className="bg-card rounded-2xl border border-border p-4 space-y-3">
          <p className="text-sm font-bold text-foreground">Métodos de pago</p>
          {[
            { name: "Nequi", color: "#7B2D8B", letter: "N" },
            { name: "Daviplata", color: "#ED1C24", letter: "D" },
            { name: "Efectivo", color: "#2E7D32", letter: "$" },
          ].map((m) => (
            <div key={m.name} className="flex items-center gap-3 p-3 rounded-xl bg-secondary">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center font-extrabold text-white text-lg" style={{ background: m.color }}>
                {m.letter}
              </div>
              <span className="text-sm font-semibold text-foreground">{m.name}</span>
            </div>
          ))}
        </div>

        {/* Upload receipt */}
        <div className="bg-card rounded-2xl border border-border p-4">
          <p className="text-sm font-bold text-foreground mb-1">Comprobante de pago</p>
          <p className="text-xs text-muted-foreground mb-4">Sube una foto o PDF del comprobante</p>

          <input
            ref={fileRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />

          {uploaded ? (
            <div className="flex items-center gap-3 p-3 rounded-xl bg-green-50 border border-green-200">
              <CheckCircle2 className="w-6 h-6 text-green-600 shrink-0" />
              <div>
                <p className="text-sm font-bold text-green-700">Comprobante subido</p>
                <p className="text-xs text-green-600">{file?.name}</p>
              </div>
            </div>
          ) : file ? (
            <div className="flex items-center gap-3 p-3 rounded-xl bg-primary/5 border border-primary/20">
              <FileText className="w-6 h-6 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground truncate">{file.name}</p>
                <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(0)} KB</p>
              </div>
              <button onClick={() => setFile(null)}><X className="w-4 h-4 text-muted-foreground" /></button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => { fileRef.current?.setAttribute("capture", "environment"); fileRef.current?.click(); }}
                className="flex flex-col items-center gap-2 py-4 rounded-xl border-2 border-dashed border-border bg-secondary hover:border-primary/40 transition-all"
              >
                <Camera className="w-6 h-6 text-primary" />
                <span className="text-xs font-semibold text-foreground">Tomar foto</span>
              </button>
              <button
                onClick={() => { fileRef.current?.removeAttribute("capture"); fileRef.current?.click(); }}
                className="flex flex-col items-center gap-2 py-4 rounded-xl border-2 border-dashed border-border bg-secondary hover:border-primary/40 transition-all"
              >
                <Upload className="w-6 h-6 text-primary" />
                <span className="text-xs font-semibold text-foreground">Subir archivo</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="px-5 pb-8 pt-3 bg-card border-t border-border space-y-2">
        {!uploaded && file && (
          <button
            onClick={handleUpload}
            disabled={uploading}
            className="w-full py-4 rounded-2xl bg-brand-gradient text-white font-bold text-base disabled:opacity-60"
          >
            {uploading ? "Subiendo..." : "Subir comprobante"}
          </button>
        )}
        <button
          onClick={onDone}
          disabled={!uploaded}
          className={`w-full py-4 rounded-2xl font-bold text-base transition-all ${
            uploaded ? "bg-green-500 text-white shadow-elevated active:scale-[0.98]" : "bg-muted text-muted-foreground"
          }`}
        >
          Confirmar y calificar
        </button>
      </div>
    </div>
  );
};

export default PaymentScreen;
