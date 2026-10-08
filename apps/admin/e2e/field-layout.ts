import { expect, type Locator } from '@playwright/test';

/** Proves the DESIGN field order in a real layout, rather than only in the DOM. */
export async function expectFieldPartsStacked({
  label,
  control,
  hint,
}: {
  readonly label: Locator;
  readonly control: Locator;
  readonly hint?: Locator;
}): Promise<void> {
  await expect(label).toBeVisible();
  await expect(control).toBeVisible();
  if (hint) {
    await expect(hint).toBeVisible();
  }

  const outlinedControl = control.locator(
    'xpath=ancestor-or-self::*[contains(@class, "MuiOutlinedInput-root")][1]',
  );
  const visibleControl = (await outlinedControl.count()) === 0 ? control : outlinedControl;
  const labelBox = await label.boundingBox();
  const controlBox = await visibleControl.boundingBox();
  const hintBox = hint ? await hint.boundingBox() : null;

  if (labelBox === null || controlBox === null || (hint !== undefined && hintBox === null)) {
    throw new Error('The field parts must have browser layout boxes');
  }

  expect(labelBox.y + labelBox.height).toBeLessThanOrEqual(controlBox.y);
  if (hintBox) {
    expect(controlBox.y + controlBox.height).toBeLessThanOrEqual(hintBox.y);
  }
}
