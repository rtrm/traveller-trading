import { MODULE_ID, TRADE_GOODS, TRADE_GOODS_FOLDER, DEFAULT_ITEM_ICON } from "./constants.mjs";

async function getOrCreateItemFolder() {
  let folder = game.folders.find(f => f.type === "Item" && f.name === TRADE_GOODS_FOLDER);
  if (!folder) {
    folder = await Folder.create({ name: TRADE_GOODS_FOLDER, type: "Item", color: "#c9a24a" });
  }
  return folder;
}

function buildItemData(good, folderId) {
  const isCargoSystem = game.system.id === "mgt2e";
  const data = {
    name: good.name,
    type: isCargoSystem ? "cargo" : "loot",
    img: DEFAULT_ITEM_ICON,
    folder: folderId
  };
  if (isCargoSystem) {
    data.system = {
      weight: 1000,
      quantity: 1,
      illegal: !!good.illegal,
      description: good.price === null
        ? (good.name === "Exotics"
          ? "Price varies; requires negotiation, not a fixed speculative-trade good."
          : "Not sold on the speculative market; income comes from freight charges, not resale.")
        : "Trade goods",
      cargo: {
        price: good.price ?? 0,
        illegal: !!good.illegal
      }
    };
  }
  return data;
}

// Creates any of the standard trade goods Items that don't already exist in
// the "Trade Goods" folder (matched by name), leaving any the GM already has
// untouched. Returns the number created.
export async function ensureTradeGoods() {
  if (!game.user.isGM) return 0;
  const folder = await getOrCreateItemFolder();
  const existingNames = new Set(
    game.items.filter(i => i.folder?.id === folder.id).map(i => i.name)
  );
  const toCreate = TRADE_GOODS.filter(g => !existingNames.has(g.name)).map(g => buildItemData(g, folder.id));
  if (toCreate.length === 0) return 0;
  await Item.createDocuments(toCreate);
  return toCreate.length;
}

// A settings-menu entry (Configure Settings > Module Settings) that checks
// for and creates any missing standard trade goods items. Uses the same
// FormApplication-with-overridden-render trick as the Drinax Tracker's
// Reset Data menu, since Foundry rejects a settings-menu "type" that isn't a
// FormApplication/ApplicationV2 subclass.
export class TradeGoodsCheckMenu extends FormApplication {
  async render() {
    const created = await ensureTradeGoods();
    if (created > 0) {
      ui.notifications.info(`Traveller Trading: created ${created} missing Trade Goods item(s).`);
    } else {
      ui.notifications.info("Traveller Trading: all standard Trade Goods items are already present.");
    }
    return this;
  }

  async _updateObject() { /* never submitted — render() is fully overridden above */ }
}

export function registerTradeGoodsSettings() {
  game.settings.registerMenu(MODULE_ID, "checkTradeGoods", {
    name: "Check Trade Goods Items",
    label: "Check / Create Trade Goods",
    hint: "Checks the Items directory's \"Trade Goods\" folder for the standard Mongoose Traveller 2e trade goods and creates any that are missing.",
    icon: "fa-solid fa-boxes-stacked",
    type: TradeGoodsCheckMenu,
    restricted: true
  });
}
