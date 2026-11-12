import { Op } from "sequelize";

export const getCursorWhere = (
  cursor: Record<string, any>,
  keys: [string, string],
) => {
  const [primaryKey, secondaryKey] = keys;
  return {
    [Op.or]: [
      {
        [primaryKey]: { [Op.lt]: cursor[primaryKey] },
      },
      {
        [primaryKey]: cursor[primaryKey],
        [secondaryKey]: { [Op.lt]: cursor[secondaryKey] },
      },
    ],
  };
};

export const decodeCursor = (cursor: string | undefined, keys: string[]) => {
  if (!cursor) return null;
  try {
    const values = cursor.split("_");
    if (values.length !== keys.length) return null;

    const result: any = {};
    keys.forEach((key, i) => {
      const val = values[i];
      const num = Number(val);
      result[key] =
        !isNaN(num) && val.trim() !== "" && !val.toLowerCase().startsWith("0x")
          ? num
          : val;
    });
    return result;
  } catch {
    return null;
  }
};

export const encodeCursor = (
  items: any[],
  keys: string[],
  originalLimit: number,
) => {
  if (!items || items.length <= originalLimit) return null;
  const lastShownItem = items[originalLimit - 1];
  if (!lastShownItem) return null;

  return keys
    .map((key) => {
      const value =
        typeof lastShownItem.get === "function"
          ? lastShownItem.get(key)
          : lastShownItem[key];
      return value;
    })
    .join("_");
};
