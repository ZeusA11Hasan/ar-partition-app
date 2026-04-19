import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-key';

// Check if keys are actually set
const isSupabaseConfigured =
    supabaseUrl !== 'https://placeholder.supabase.co' &&
    supabaseKey !== 'placeholder-key';

if (!isSupabaseConfigured) {
    console.warn('Supabase is not yet configured. "Save Layout" will not work.');
}

export const supabase = createClient(supabaseUrl, supabaseKey);
export { isSupabaseConfigured };
