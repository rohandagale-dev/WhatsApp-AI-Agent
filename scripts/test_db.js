const { supabase } = require('../services/supabaseClient');

async function test() {
  console.log("Testing query...");
  const { data: personas, error: queryError } = await supabase.from('personas').select('*');
  console.log("Existing personas:", personas);
  if (queryError) console.error("Query Error:", queryError);

  console.log("\nTesting insert...");
  const { data: newPersona, error: insertError } = await supabase.from('personas').insert({
    name: "Default"
  }).select().single();
  
  console.log("Inserted Persona:", newPersona);
  if (insertError) console.error("Insert Error:", insertError);
}

test();
