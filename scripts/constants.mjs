export const MODULE_ID = "traveller-trading";

// Standard Mongoose Traveller 2e trade goods (base price in Cr per ton at
// dTon 1 lot). Freight and Exotics have no fixed base price in the rules
// (freight income isn't a resold commodity; exotics require negotiation),
// so they're created with price left at 0 and a note explaining why.
export const TRADE_GOODS = [
  { name: "Freight", price: null },
  { name: "Common Electronics", price: 20000 },
  { name: "Common Industrial Goods", price: 10000 },
  { name: "Common Manufactured Goods", price: 20000 },
  { name: "Common Raw Materials", price: 5000 },
  { name: "Common Consumables", price: 500 },
  { name: "Common Ore", price: 1000 },
  { name: "Advanced Electronics", price: 100000 },
  { name: "Advanced Machine Parts", price: 75000 },
  { name: "Advanced Manufactured Goods", price: 100000 },
  { name: "Advanced Weapons", price: 150000 },
  { name: "Advanced Vehicles", price: 180000 },
  { name: "Biochemicals", price: 50000 },
  { name: "Crystals & Gems", price: 20000 },
  { name: "Cybernetics", price: 250000 },
  { name: "Live Animals", price: 10000 },
  { name: "Luxury Consumables", price: 20000 },
  { name: "Luxury Goods", price: 200000 },
  { name: "Medical Supplies", price: 50000 },
  { name: "Petrochemicals", price: 10000 },
  { name: "Pharmaceuticals", price: 100000 },
  { name: "Polymers", price: 7000 },
  { name: "Precious Metals", price: 50000 },
  { name: "Radioactives", price: 1000000 },
  { name: "Robots", price: 400000 },
  { name: "Spices", price: 6000 },
  { name: "Textiles", price: 3000 },
  { name: "Uncommon Ore", price: 5000 },
  { name: "Uncommon Raw Materials", price: 20000 },
  { name: "Wood", price: 1000 },
  { name: "Vehicles", price: 15000 },
  { name: "Illegal Biochemicals", price: 50000, illegal: true },
  { name: "Illegal Cybernetics", price: 250000, illegal: true },
  { name: "Illegal Drugs", price: 100000, illegal: true },
  { name: "Illegal Luxuries", price: 50000, illegal: true },
  { name: "Illegal Weapons", price: 150000, illegal: true },
  { name: "Exotics", price: null },
];

export const TRADE_GOODS_FOLDER = "Trade Goods";
export const DEFAULT_ITEM_ICON = "systems/mgt2e/icons/items/item.svg";

// Passage categories, best to worst, matching Mongoose Traveller 2e's
// passenger berth terminology. "middle" covers the Configuration tab's
// "Medium Berths" field (same category, official term is "Middle").
export const PASSENGER_CATEGORIES = [
  { id: "high", label: "High Passenger", color: "#c9a24a" },
  { id: "middle", label: "Middle Passenger", color: "#4fb0a6" },
  { id: "basic", label: "Basic Passenger", color: "#8892a3" },
  { id: "low", label: "Low Passenger", color: "#6b7fa6" },
];

export function passengerCategoryInfo(id) {
  return PASSENGER_CATEGORIES.find(c => c.id === id) || PASSENGER_CATEGORIES[2];
}

// Passage income by parsecs travelled (row) and category (column), Cr per
// passenger, per the Mongoose Traveller 2e passenger table.
export const PASSENGER_INCOME = {
  1: { high: 9000, middle: 6500, basic: 2000, low: 700 },
  2: { high: 14000, middle: 10000, basic: 3000, low: 1300 },
  3: { high: 21000, middle: 14000, basic: 5000, low: 2200 },
  4: { high: 34000, middle: 23000, basic: 8000, low: 3900 },
  5: { high: 60000, middle: 40000, basic: 14000, low: 7200 },
  6: { high: 210000, middle: 130000, basic: 55000, low: 27000 },
};

export function passengerIncome(parsecs, category) {
  const row = PASSENGER_INCOME[Math.min(6, Math.max(1, Math.round(parsecs) || 1))];
  return row ? (row[category] ?? 0) : 0;
}

export const RECURRING_COST_PERIODS = [
  { id: "7", label: "Every 7 days" },
  { id: "30", label: "Every 30 days" },
  { id: "starport", label: "Starport (manual)" },
];
