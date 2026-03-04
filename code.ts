type DtcgToken = {
  $value: unknown;
  $type?: string;
  $description?: string;
  $extensions?: Record<string, unknown>;
};

interface DtcgTree {
  [key: string]: DtcgTree | DtcgToken;
}

type UiMessage =
  | {
      type: "refresh-tokens";
      options?: {
        includeCollectionOrCategoryRoot?: boolean;
        splitByCollectionOrCategory?: boolean;
      };
    }
  | { type: "close-plugin" };

type TokenFile = {
  name: string;
  filename: string;
  json: string;
};

type GeneratedPayload =
  | { mode: "single"; file: TokenFile }
  | { mode: "split"; files: TokenFile[] };

const DTCG_SCHEMA_URL =
  "https://www.designtokens.org/schemas/2025.10/format.json";

figma.showUI(__html__, {
  width: 760,
  height: 640,
  themeColors: true,
});

let includeCollectionOrCategoryRoot = true;
let splitByCollectionOrCategory = false;

function normalizeNameSegment(segment: string): string {
  const normalized = segment.trim().replace(/\s+/g, "-");
  return normalized.length > 0 ? normalized : "unnamed";
}

function splitTokenPath(path: string): string[] {
  return path
    .split("/")
    .map((segment) => normalizeNameSegment(segment))
    .filter(Boolean);
}

function setToken(tree: DtcgTree, path: string, token: DtcgToken): void {
  const segments = splitTokenPath(path);
  if (segments.length === 0) {
    return;
  }

  let current: DtcgTree = tree;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const next = current[segment];
    if (!next || "$value" in next) {
      current[segment] = {};
    }
    current = current[segment] as DtcgTree;
  }
  current[segments[segments.length - 1]] = token;
}

function isTokenNode(node: DtcgTree | DtcgToken): node is DtcgToken {
  return "$value" in node;
}

function mergeDtcgTrees(base: DtcgTree, incoming: DtcgTree): DtcgTree {
  const merged: DtcgTree = { ...base };

  for (const key of Object.keys(incoming)) {
    const existingNode = merged[key];
    const incomingNode = incoming[key];

    if (!existingNode) {
      merged[key] = incomingNode;
      continue;
    }

    if (isTokenNode(existingNode) || isTokenNode(incomingNode)) {
      // On exact path collision, last writer wins to keep deterministic output.
      merged[key] = incomingNode;
      continue;
    }

    merged[key] = mergeDtcgTrees(existingNode, incomingNode);
  }

  return merged;
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

function toHexByte(value: number): string {
  const hex = Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16);
  return hex.length === 1 ? `0${hex}` : hex;
}

function colorToHex(color: RGB, opacity = 1): string {
  const alpha = Math.max(0, Math.min(1, opacity));
  const base = `#${toHexByte(color.r)}${toHexByte(color.g)}${toHexByte(color.b)}`;
  return alpha < 1 ? `${base}${toHexByte(alpha)}` : base;
}

function colorToDtcgColor(color: RGB, alpha = 1): { colorSpace: "srgb"; components: [number, number, number]; alpha?: number } {
  const normalizedAlpha = Math.max(0, Math.min(1, alpha));
  const output: { colorSpace: "srgb"; components: [number, number, number]; alpha?: number } = {
    colorSpace: "srgb",
    components: [round4(color.r), round4(color.g), round4(color.b)],
  };
  if (normalizedAlpha < 1) {
    output.alpha = round4(normalizedAlpha);
  }
  return output;
}

function colorToModeExtension(color: RGB, alpha = 1): {
  colorSpace: "srgb";
  components: [number, number, number];
  alpha: number;
  hex: string;
} {
  return {
    colorSpace: "srgb",
    components: [round4(color.r), round4(color.g), round4(color.b)],
    alpha: round4(Math.max(0, Math.min(1, alpha))),
    hex: colorToHex(color, alpha),
  };
}

function numberToPx(value: number): string {
  return `${Number(value.toFixed(4))}px`;
}

function numberWithUnit(value: number, unit: string): { value: number; unit: string } {
  return {
    value: round4(value),
    unit,
  };
}

function valueToReference(path: string): string {
  return `{${splitTokenPath(path).join(".")}}`;
}

function toFileSafeName(name: string): string {
  const safe = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-");
  return safe.replace(/^-|-$/g, "") || "tokens";
}

async function getLocalCollections(): Promise<VariableCollection[]> {
  return figma.variables.getLocalVariableCollectionsAsync();
}

async function getVariableById(id: string): Promise<Variable | null> {
  return figma.variables.getVariableByIdAsync(id);
}

async function getPaintStyles(): Promise<PaintStyle[]> {
  return figma.getLocalPaintStylesAsync();
}

async function getTextStyles(): Promise<TextStyle[]> {
  return figma.getLocalTextStylesAsync();
}

async function getEffectStyles(): Promise<EffectStyle[]> {
  return figma.getLocalEffectStylesAsync();
}

async function getGridStyles(): Promise<GridStyle[]> {
  return figma.getLocalGridStylesAsync();
}

function mapVariableTypeToDtcgType(variableType: VariableResolvedDataType): string {
  if (variableType === "COLOR") return "color";
  if (variableType === "FLOAT") return "number";
  if (variableType === "STRING") return "string";
  if (variableType === "BOOLEAN") return "boolean";
  return "string";
}

function convertVariableValue(
  value: VariableValue,
  variableType: VariableResolvedDataType,
  fallbackPath?: string
): unknown {
  if (typeof value === "object" && value !== null && "type" in value && value.type === "VARIABLE_ALIAS") {
    if (fallbackPath) {
      return valueToReference(fallbackPath);
    }
    return `{alias-missing.${value.id}}`;
  }

  if (variableType === "COLOR" && typeof value === "object" && value !== null && "r" in value) {
    const colorValue = value as RGBA;
    return colorToDtcgColor(colorValue, colorValue.a);
  }

  return value;
}

function textLineHeightToDtcg(lineHeight: LineHeight): string | number {
  if (lineHeight.unit === "AUTO") return "normal";
  if (lineHeight.unit === "PIXELS") return numberToPx(lineHeight.value);
  if (lineHeight.unit === "PERCENT") return round4(lineHeight.value / 100);
  return round4(lineHeight.value / 100);
}

function textLetterSpacingToDtcg(
  letterSpacing: LetterSpacing,
  fontSize: number
): { value: number; unit: "px" } {
  if (letterSpacing.unit === "PIXELS") {
    return {
      value: round4(letterSpacing.value),
      unit: "px",
    };
  }

  const pxValue = (fontSize * letterSpacing.value) / 100;
  return {
    value: round4(pxValue),
    unit: "px",
  };
}

function mapTextCase(textCase: TextCase): string {
  if (textCase === "UPPER") return "uppercase";
  if (textCase === "LOWER") return "lowercase";
  if (textCase === "TITLE") return "capitalize";
  if (textCase === "SMALL_CAPS" || textCase === "SMALL_CAPS_FORCED") return "small-caps";
  return "none";
}

function mapTextDecoration(textDecoration: TextDecoration): string {
  if (textDecoration === "UNDERLINE") return "underline";
  if (textDecoration === "STRIKETHROUGH") return "line-through";
  return "none";
}

function toKebabLower(text: string): string {
  return text
    .trim()
    .replace(/[_\s]+/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/-+/g, "-")
    .toLowerCase();
}

function firstVisiblePaint(paints: ReadonlyArray<Paint>): Paint | null {
  return paints.find((paint) => paint.visible !== false) ?? paints[0] ?? null;
}

function convertPaintToToken(style: PaintStyle): DtcgToken {
  const paint = firstVisiblePaint(style.paints);
  if (!paint) {
    return {
      $type: "color",
      $value: colorToDtcgColor({ r: 0, g: 0, b: 0 }, 0),
      $description: style.description || undefined,
    };
  }

  if (paint.type === "SOLID") {
    return {
      $type: "color",
      $value: colorToDtcgColor(paint.color, paint.opacity ?? 1),
      $description: style.description || undefined,
    };
  }

  if (
    paint.type === "GRADIENT_LINEAR" ||
    paint.type === "GRADIENT_RADIAL" ||
    paint.type === "GRADIENT_ANGULAR" ||
    paint.type === "GRADIENT_DIAMOND"
  ) {
    return {
      $type: "gradient",
      $value: paint.gradientStops.map((stop: ColorStop) => ({
        color: colorToDtcgColor(stop.color, stop.color.a),
        position: Number(stop.position.toFixed(4)),
      })),
      $description: style.description || undefined,
      $extensions: {
        figmaGradientType: paint.type,
      },
    };
  }

  return {
    $type: "string",
    $value: paint.type,
    $description: style.description || undefined,
    $extensions: {
      figmaPaint: paint,
    },
  };
}

function convertTextToToken(style: TextStyle): DtcgToken {
  const fontName = typeof style.fontName === "symbol" ? null : style.fontName;
  return {
    $type: "typography",
    $value: {
      fontFamily: fontName?.family ?? "Unknown",
      fontWeight: toKebabLower(fontName?.style ?? "regular"),
      fontSize: numberWithUnit(style.fontSize, "px"),
      lineHeight: textLineHeightToDtcg(style.lineHeight),
      letterSpacing: textLetterSpacingToDtcg(style.letterSpacing, style.fontSize),
      paragraphSpacing: numberToPx(style.paragraphSpacing),
      paragraphIndent: numberToPx(style.paragraphIndent),
      textCase: mapTextCase(style.textCase),
      textDecoration: mapTextDecoration(style.textDecoration),
    },
    $description: style.description || undefined,
  };
}

function convertEffectsToToken(style: EffectStyle): DtcgToken {
  const shadows = style.effects
    .filter(
      (effect): effect is DropShadowEffect | InnerShadowEffect =>
        effect.visible !== false && (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW")
    )
    .map((effect) => ({
      color: colorToDtcgColor(effect.color, effect.color.a),
      offsetX: numberWithUnit(effect.offset.x, "px"),
      offsetY: numberWithUnit(effect.offset.y, "px"),
      blur: numberWithUnit(effect.radius, "px"),
      spread: numberWithUnit(effect.spread ?? 0, "px"),
      inset: effect.type === "INNER_SHADOW",
    }));

  if (shadows.length > 0) {
    return {
      $type: "shadow",
      $value: shadows.length === 1 ? shadows[0] : shadows,
      $description: style.description || undefined,
    };
  }

  return {
    $type: "string",
    $value: style.effects.map((effect) => effect.type).join(", "),
    $description: style.description || undefined,
    $extensions: {
      figmaEffects: style.effects,
    },
  };
}

function convertGridToToken(style: GridStyle): DtcgToken {
  return {
    $type: "string",
    $value: "grid-style",
    $description: style.description || undefined,
    $extensions: {
      figmaLayoutGrids: style.layoutGrids,
    },
  };
}

function variableTokenPath(
  collectionName: string,
  variableName: string,
  includeRoot: boolean
): string {
  return includeRoot ? `${collectionName}/${variableName}` : variableName;
}

function styleTokenPath(category: string, styleName: string, includeRoot: boolean): string {
  return includeRoot ? `${category}/${styleName}` : styleName;
}

async function buildVariableTokensByCollection(includeRoot: boolean): Promise<Record<string, DtcgTree>> {
  const variableGroups: Record<string, DtcgTree> = {};
  const pathByVariableId: Record<string, string> = {};

  const collections = await getLocalCollections();
  for (const collection of collections) {
    for (const variableId of collection.variableIds) {
      const variable = await getVariableById(variableId);
      if (!variable) continue;

      const tokenPath = variableTokenPath(collection.name, variable.name, includeRoot);
      pathByVariableId[variable.id] = tokenPath;
    }
  }

  for (const collection of collections) {
    variableGroups[collection.name] = variableGroups[collection.name] ?? {};
    const modeById = new Map(collection.modes.map((mode) => [mode.modeId, mode.name]));
    const defaultModeId = collection.defaultModeId;
    const hasMultipleModes = collection.modes.length > 1;

    for (const variableId of collection.variableIds) {
      const variable = await getVariableById(variableId);
      if (!variable) continue;

      const tokenPath = variableTokenPath(collection.name, variable.name, includeRoot);
      const modeValues: Record<string, unknown> = {};

      for (const modeId of Object.keys(variable.valuesByMode)) {
        const rawValue = variable.valuesByMode[modeId];
        const modeName = modeById.get(modeId) ?? modeId;
        const aliasSource =
          typeof rawValue === "object" &&
          rawValue !== null &&
          "type" in rawValue &&
          rawValue.type === "VARIABLE_ALIAS"
            ? pathByVariableId[rawValue.id]
            : undefined;

        const converted = convertVariableValue(rawValue, variable.resolvedType, aliasSource);
        if (
          variable.resolvedType === "COLOR" &&
          typeof rawValue === "object" &&
          rawValue !== null &&
          "r" in rawValue
        ) {
          const rgba = rawValue as RGBA;
          modeValues[modeName] = colorToModeExtension(rgba, rgba.a);
        } else {
          modeValues[modeName] = converted;
        }
      }

      const defaultRawValue = variable.valuesByMode[defaultModeId];
      const defaultAliasSource =
        typeof defaultRawValue === "object" &&
        defaultRawValue !== null &&
        "type" in defaultRawValue &&
        defaultRawValue.type === "VARIABLE_ALIAS"
          ? pathByVariableId[defaultRawValue.id]
          : undefined;
      const defaultValue = convertVariableValue(
        defaultRawValue,
        variable.resolvedType,
        defaultAliasSource
      );

      const extensions: Record<string, unknown> = {
        figmaVariableId: variable.id,
        figmaCollectionId: collection.id,
        figmaScopes: variable.scopes,
      };
      if (hasMultipleModes) {
        extensions.mode = modeValues;
      }

      setToken(variableGroups[collection.name], tokenPath, {
        $type: mapVariableTypeToDtcgType(variable.resolvedType),
        $value: defaultValue,
        $description: variable.description || undefined,
        $extensions: extensions,
      });
    }
  }

  return variableGroups;
}

async function buildStyleTokensByCategory(includeRoot: boolean): Promise<Record<string, DtcgTree>> {
  const styleGroups: Record<string, DtcgTree> = {
    color: {},
    typography: {},
    effects: {},
    grid: {},
  };

  const [paintStyles, textStyles, effectStyles, gridStyles] = await Promise.all([
    getPaintStyles(),
    getTextStyles(),
    getEffectStyles(),
    getGridStyles(),
  ]);

  for (const style of paintStyles) {
    setToken(styleGroups.color, styleTokenPath("color", style.name, includeRoot), convertPaintToToken(style));
  }

  for (const style of textStyles) {
    setToken(
      styleGroups.typography,
      styleTokenPath("typography", style.name, includeRoot),
      convertTextToToken(style)
    );
  }

  for (const style of effectStyles) {
    setToken(styleGroups.effects, styleTokenPath("effects", style.name, includeRoot), convertEffectsToToken(style));
  }

  for (const style of gridStyles) {
    setToken(styleGroups.grid, styleTokenPath("grid", style.name, includeRoot), convertGridToToken(style));
  }

  return styleGroups;
}

function createDtcgPayload(tokens: DtcgTree, generatedAt: string) {
  return {
    $schema: DTCG_SCHEMA_URL,
    $metadata: {
      tokenFormat: "DTCG",
      tokenFormatVersion: "2025.10",
      generator: "dtcg-tokens-figma-plugin",
      generatedAt,
    },
    ...tokens,
  };
}

function mergeTreeGroupMap(source: Record<string, DtcgTree>, target: Record<string, DtcgTree>): void {
  for (const groupName of Object.keys(source)) {
    target[groupName] = target[groupName]
      ? mergeDtcgTrees(target[groupName], source[groupName])
      : source[groupName];
  }
}

async function generateTokens(): Promise<GeneratedPayload> {
  const generatedAt = new Date().toISOString();
  const [variableGroups, styleGroups] = await Promise.all([
    buildVariableTokensByCollection(includeCollectionOrCategoryRoot),
    buildStyleTokensByCategory(includeCollectionOrCategoryRoot),
  ]);

  if (splitByCollectionOrCategory) {
    const allGroups: Record<string, DtcgTree> = {};
    mergeTreeGroupMap(variableGroups, allGroups);
    mergeTreeGroupMap(styleGroups, allGroups);

    const files: TokenFile[] = [];
    for (const groupName of Object.keys(allGroups).sort()) {
      files.push({
        name: groupName,
        filename: `${toFileSafeName(groupName)}.tokens.json`,
        json: JSON.stringify(createDtcgPayload(allGroups[groupName], generatedAt), null, 2),
      });
    }

    return {
      mode: "split",
      files,
    };
  }

  let mergedTokens: DtcgTree = {};
  for (const groupName of Object.keys(variableGroups)) {
    mergedTokens = mergeDtcgTrees(mergedTokens, variableGroups[groupName]);
  }
  for (const groupName of Object.keys(styleGroups)) {
    mergedTokens = mergeDtcgTrees(mergedTokens, styleGroups[groupName]);
  }

  return {
    mode: "single",
    file: {
      name: "tokens",
      filename: "tokens.json",
      json: JSON.stringify(createDtcgPayload(mergedTokens, generatedAt), null, 2),
    },
  };
}

async function sendTokensToUi(): Promise<void> {
  try {
    const payload = await generateTokens();
    figma.ui.postMessage({
      type: "tokens-generated",
      payload,
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "tokens-error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

figma.ui.onmessage = async (msg: UiMessage) => {
  if (msg.type === "refresh-tokens") {
    includeCollectionOrCategoryRoot =
      msg.options?.includeCollectionOrCategoryRoot ?? includeCollectionOrCategoryRoot;
    splitByCollectionOrCategory =
      msg.options?.splitByCollectionOrCategory ?? splitByCollectionOrCategory;
    await sendTokensToUi();
    return;
  }

  if (msg.type === "close-plugin") {
    figma.closePlugin();
  }
};

void sendTokensToUi();
