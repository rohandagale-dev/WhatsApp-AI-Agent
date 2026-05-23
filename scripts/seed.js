require('dotenv').config();
const { supabase } = require('../services/supabaseClient');

async function main() {
  console.log('Seeding database...');

  // Create a specialized persona for Rohan
  const { data: rohanPersonaArr, error: rohanErr } = await supabase.from('personas').upsert({
    id: 2,
    name: "Rohan's Agent",
    tone: "persuasive",
    style: "short",
    system_prompt: "You are Rohan's personal assistant. Be brief, professional, and slightly witty.",
    language: "marathi, hindi, english, hinglish"
  }, { onConflict: 'id' }).select();
  const rohanPersona = rohanPersonaArr[0];

  // Link the phone number to this persona
  await supabase.from('contacts').upsert({
    phone: "918485078050",
    persona_id: rohanPersona.id,
    notes: "Primary user"
  }, { onConflict: 'phone' });

  // Create a second persona with different language for the new number
  const { data: secondPersonaArr, error: secondErr } = await supabase.from('personas').upsert({
    id: 3,
    name: "Standard Agent",
    tone: "helpful",
    style: "short",
    system_prompt: "You are a helpful AI assistant. Be direct and polite.",
    language: "hindi, english"
  }, { onConflict: 'id' }).select();
  const secondPersona = secondPersonaArr[0];

  await supabase.from('contacts').upsert({
    phone: "919022384150",
    persona_id: secondPersona.id,
    notes: "Hindi/English User"
  }, { onConflict: 'phone' });

  // Link the third phone number to the same Standard Agent persona
  await supabase.from('contacts').upsert({
    phone: "918828375540",
    persona_id: secondPersona.id,
    notes: "English/Hindi User 2"
  }, { onConflict: 'phone' });

  // Create a third persona for the new number (marathi, hindi, english)
  const { data: thirdPersonaArr } = await supabase.from('personas').upsert({
    id: 4,
    name: "Marathi/Hindi/English Agent",
    tone: "helpful",
    style: "short",
    system_prompt: "You are a helpful AI assistant. Be direct and polite.",
    language: "marathi, hindi, english"
  }, { onConflict: 'id' }).select();
  const thirdPersona = thirdPersonaArr[0];

  await supabase.from('contacts').upsert({
    phone: "919022635696",
    persona_id: thirdPersona.id,
    notes: "Marathi/Hindi/English User"
  }, { onConflict: 'phone' });

  console.log('Seeding complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
