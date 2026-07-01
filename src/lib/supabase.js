import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.REACT_APP_SUPABASE_URL;
const supabaseAnonKey = process.env.REACT_APP_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('Missing Supabase environment variables. Check your .env file.');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ─── Chat helpers ─────────────────────────────────────────────────────────────

/**
 * Load all chats for a user (index only — no messages)
 */
export async function loadChatIndex(userId) {
  const { data, error } = await supabase
    .from('chats')
    .select('id, title, updated_at, created_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });

  if (error) { console.error('loadChatIndex error:', error); return []; }
  return data.map(c => ({
    id: c.id,
    title: c.title,
    updatedAt: new Date(c.updated_at).getTime(),
    createdAt: new Date(c.created_at).getTime(),
  }));
}

/**
 * Load full messages for a specific chat
 */
export async function loadChat(chatId, userId) {
  const { data, error } = await supabase
    .from('chats')
    .select('id, title, messages, updated_at')
    .eq('id', chatId)
    .eq('user_id', userId)
    .single();

  if (error) { console.error('loadChat error:', error); return null; }
  return {
    id: data.id,
    title: data.title,
    messages: data.messages || [],
    updatedAt: new Date(data.updated_at).getTime(),
  };
}

/**
 * Save or update a chat (upsert)
 */
export async function saveChat(chatId, userId, title, messages) {
  // Strip base64 image data — only keep previewUrl for display
  const slim = messages.map(m => ({
    role: m.role,
    content: m.content,
    apiContent: m.apiContent || null,
    images: m.images || null,
  }));

  const { error } = await supabase
    .from('chats')
    .upsert({
      id: chatId,
      user_id: userId,
      title,
      messages: slim,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });

  if (error) { console.error('saveChat error:', error); return false; }
  return true;
}

/**
 * Rename a chat
 */
export async function renameChat(chatId, userId, newTitle) {
  const { error } = await supabase
    .from('chats')
    .update({ title: newTitle, updated_at: new Date().toISOString() })
    .eq('id', chatId)
    .eq('user_id', userId);

  if (error) { console.error('renameChat error:', error); return false; }
  return true;
}

/**
 * Delete a chat
 */
export async function deleteChat(chatId, userId) {
  const { error } = await supabase
    .from('chats')
    .delete()
    .eq('id', chatId)
    .eq('user_id', userId);

  if (error) { console.error('deleteChat error:', error); return false; }
  return true;
}

// ─── Alarm log helpers ────────────────────────────────────────────────────────

export async function loadAlarms(userId) {
  const { data, error } = await supabase
    .from('alarm_logs')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) { console.error('loadAlarms error:', error); return []; }
  return data;
}

export async function saveAlarm(alarm, userId) {
  const { error } = await supabase
    .from('alarm_logs')
    .upsert({ ...alarm, user_id: userId }, { onConflict: 'id' });

  if (error) { console.error('saveAlarm error:', error); return false; }
  return true;
}

export async function deleteAlarm(alarmId, userId) {
  const { error } = await supabase
    .from('alarm_logs')
    .delete()
    .eq('id', alarmId)
    .eq('user_id', userId);

  if (error) { console.error('deleteAlarm error:', error); return false; }
  return true;
}

// ─── Asset registry helpers ───────────────────────────────────────────────────

export async function loadAssets(userId) {
  const { data, error } = await supabase
    .from('assets')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) { console.error('loadAssets error:', error); return []; }
  return data;
}

export async function saveAsset(asset, userId) {
  const { error } = await supabase
    .from('assets')
    .upsert({ ...asset, user_id: userId }, { onConflict: 'id' });

  if (error) { console.error('saveAsset error:', error); return false; }
  return true;
}

export async function deleteAsset(assetId, userId) {
  const { error } = await supabase
    .from('assets')
    .delete()
    .eq('id', assetId)
    .eq('user_id', userId);

  if (error) { console.error('deleteAsset error:', error); return false; }
  return true;
}
