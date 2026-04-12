require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Create a specialized persona for Rohan
  const rohanPersona = await prisma.persona.upsert({
    where: { id: 2 }, // Using a fixed ID for the specific request
    update: {
      name: "Rohan's Agent",
      tone: "persuasive",
      style: "short",
      systemPrompt: "You are Rohan's personal assistant. Be brief, professional, and slightly witty.",
      language: "marathi, hindi, english, hinglish"
    },
    create: {
      id: 2,
      name: "Rohan's Agent",
      tone: "persuasive",
      style: "short",
      systemPrompt: "You are Rohan's personal assistant. Be brief, professional, and slightly witty.",
      language: "marathi, hindi, english, hinglish"
    }
  });

  // Link the phone number to this persona
  await prisma.contact.upsert({
    where: { phone: "918485078050" },
    update: {
      personaId: rohanPersona.id,
      notes: "Primary user"
    },
    create: {
      phone: "918485078050",
      personaId: rohanPersona.id,
      notes: "Primary user"
    }
  });

  // Create a second persona with different language for the new number
  const secondPersona = await prisma.persona.upsert({
    where: { id: 3 },
    update: {
      name: "Standard Agent",
      tone: "helpful",
      style: "short",
      systemPrompt: "You are a helpful AI assistant. Be direct and polite.",
      language: "hindi, english"
    },
    create: {
      id: 3,
      name: "Standard Agent",
      tone: "helpful",
      style: "short",
      systemPrompt: "You are a helpful AI assistant. Be direct and polite.",
      language: "hindi, english"
    }
  });

  await prisma.contact.upsert({
    where: { phone: "919022384150" },
    update: {
      personaId: secondPersona.id,
      notes: "Hindi/English User"
    },
    create: {
      phone: "919022384150",
      personaId: secondPersona.id,
      notes: "Hindi/English User"
    }
  });

  // Link the third phone number to the same Standard Agent persona
  await prisma.contact.upsert({
    where: { phone: "918828375540" },
    update: {
      personaId: secondPersona.id,
      notes: "English/Hindi User 2"
    },
    create: {
      phone: "918828375540",
      personaId: secondPersona.id,
      notes: "English/Hindi User 2"
    }
  });

  // Create a third persona for the new number (marathi, hindi, english)
  const thirdPersona = await prisma.persona.upsert({
    where: { id: 4 },
    update: {
      name: "Marathi/Hindi/English Agent",
      tone: "helpful",
      style: "short",
      systemPrompt: "You are a helpful AI assistant. Be direct and polite.",
      language: "marathi, hindi, english"
    },
    create: {
      id: 4,
      name: "Marathi/Hindi/English Agent",
      tone: "helpful",
      style: "short",
      systemPrompt: "You are a helpful AI assistant. Be direct and polite.",
      language: "marathi, hindi, english"
    }
  });

  await prisma.contact.upsert({
    where: { phone: "919022635696" },
    update: {
      personaId: thirdPersona.id,
      notes: "Marathi/Hindi/English User"
    },
    create: {
      phone: "919022635696",
      personaId: thirdPersona.id,
      notes: "Marathi/Hindi/English User"
    }
  });

  console.log('Seeding complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
