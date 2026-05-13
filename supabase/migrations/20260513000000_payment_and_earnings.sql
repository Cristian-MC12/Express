-- Add completed_tasks and earnings columns to profiles if they don't exist
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS completed_tasks INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_earnings NUMERIC(12,2) NOT NULL DEFAULT 0;

-- Allow taskers to update their own offers (needed for completion flow)
DROP POLICY IF EXISTS "Clients can update task offers" ON public.offers;
CREATE POLICY "Clients can update task offers" ON public.offers
  FOR UPDATE USING (
    auth.uid() = tasker_id OR
    auth.uid() = (SELECT client_id FROM public.tasks WHERE id = task_id)
  );

-- Create tasker_earnings table if it doesn't exist
CREATE TABLE IF NOT EXISTS public.tasker_earnings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tasker_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_id UUID REFERENCES public.tasks(id) ON DELETE SET NULL,
  amount NUMERIC(12,2) NOT NULL,
  commission NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.tasker_earnings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Taskers can view own earnings" ON public.tasker_earnings
  FOR SELECT USING (auth.uid() = tasker_id);

-- Function: called when client confirms payment
-- Deducts credits from client, adds earnings to tasker, increments completed_tasks on both
CREATE OR REPLACE FUNCTION public.confirm_task_payment(
  p_task_id UUID,
  p_client_id UUID,
  p_amount NUMERIC
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tasker_id UUID;
  v_commission NUMERIC;
  v_net NUMERIC;
BEGIN
  -- Get tasker from accepted offer
  SELECT o.tasker_id INTO v_tasker_id
  FROM tasks t
  JOIN offers o ON o.id = t.accepted_offer_id
  WHERE t.id = p_task_id;

  IF v_tasker_id IS NULL THEN
    RAISE EXCEPTION 'No accepted offer found for task %', p_task_id;
  END IF;

  -- 10% platform commission
  v_commission := ROUND(p_amount * 0.10, 2);
  v_net := p_amount - v_commission;

  -- Mark task as completed
  UPDATE tasks SET status = 'completed' WHERE id = p_task_id;

  -- Deduct credits from client (floor at 0)
  UPDATE profiles
  SET credits = GREATEST(0, credits - p_amount::INTEGER)
  WHERE user_id = p_client_id;

  -- Add net earnings to tasker and increment completed_tasks
  UPDATE profiles
  SET
    total_earnings = total_earnings + v_net,
    completed_tasks = completed_tasks + 1
  WHERE user_id = v_tasker_id;

  -- Increment completed_tasks for client too
  UPDATE profiles
  SET completed_tasks = completed_tasks + 1
  WHERE user_id = p_client_id;

  -- Insert into tasker_earnings for the earnings history view
  INSERT INTO public.tasker_earnings (tasker_id, task_id, amount, commission)
  VALUES (v_tasker_id, p_task_id, v_net, v_commission);
END;
$$;

-- Function: deduct commission only (called by tasker on complete, kept for compatibility)
CREATE OR REPLACE FUNCTION public.deduct_task_commission(
  p_task_id UUID,
  offer_price NUMERIC
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- This is now a no-op; confirm_task_payment handles everything
  -- Kept for backward compatibility
  RETURN;
END;
$$;
