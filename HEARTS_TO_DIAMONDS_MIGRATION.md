# Hearts to Diamonds Migration Guide

## Overview
This document lists all the places where changes need to be made to replace hearts with diamonds for upload activities. The logic for earning diamonds will be exactly like hearts currently works. Hearts field will remain in the database but will have different logic in the future.

---

## 1. Database Tables

### 1.1 `flms` table (`sql/flmTable.sql`)
- **Current:** `hearts` int DEFAULT '0'
- **Action:** Keep `hearts` field, ensure `diamonds` field exists (already exists: `diamonds` int DEFAULT '0')
- **Status:** ✅ No changes needed (both fields exist)

### 1.2 `brands` table (`sql/brandTable.sql`)
- **Current:** `hearts` int DEFAULT '0'
- **Action:** 
  - Keep `hearts` field
  - Add `diamonds` field: `diamonds` int DEFAULT '0'
- **File:** `sql/brandTable.sql` (line 22)

### 1.3 `camps` table (`sql/campsTable.sql`)
- **Current:** `hearts` int DEFAULT NULL
- **Action:**
  - Keep `hearts` field
  - Add `diamonds` field: `diamonds` int DEFAULT NULL
- **File:** `sql/campsTable.sql` (line 6)

### 1.4 `activityTypes` table (activitySpecificFields JSON)
- **Current:** Fields can have `hearts` property
- **Action:**
  - Keep `hearts` property (for future use)
  - Add `diamonds` property support
- **Note:** This is in the JSON structure, not a database column

---

## 2. Controllers - Upload Logic (`mrController.js`)

### 2.1 `uploadFile` function - Dynamic Calculation
**Location:** Lines ~350-475

**Changes needed:**
1. **Variable name:** `calculatedHearts` → `calculatedDiamonds`
2. **Field-level calculation (lines ~456-470):**
   - Change: `const hearts = Number(fieldDef.hearts) || 0;`
   - To: `const diamonds = Number(fieldDef.diamonds) || 0;`
   - Change: `calculatedHearts += hearts * numericValue;`
   - To: `calculatedDiamonds += diamonds * numericValue;`

3. **Dropdown option calculation (lines ~409-436):**
   - Change: `selectedOption.hearts` → `selectedOption.diamonds`
   - Change: `optionHearts` → `optionDiamonds`
   - Change: `calculatedHearts += optionHearts * numericValue;`
   - To: `calculatedDiamonds += optionDiamonds * numericValue;`

4. **Store calculated value (lines ~596-599, 672-675):**
   - Change: `activitySpecificDetails._calculatedHearts = calculatedHearts;`
   - To: `activitySpecificDetails._calculatedDiamonds = calculatedDiamonds;`

### 2.2 `uploadFile` function - Auto-approval Awards
**Location:** Lines ~760-860

**Changes needed:**
1. **Brand-based awards (lines ~763-799):**
   - Change: `SELECT hearts, diceRolls` → `SELECT diamonds, diceRolls`
   - Change: `brandHearts` → `brandDiamonds`
   - Change: `heartsToAward` → `diamondsToAward`
   - Change: `SET hearts = COALESCE(hearts, 0) + ?` → `SET diamonds = COALESCE(diamonds, 0) + ?`

2. **Camp-based awards (lines ~814-847):**
   - Change: `SELECT hearts, diceRolls` → `SELECT diamonds, diceRolls`
   - Change: `campHearts` → `campDiamonds`
   - Change: `heartsToAward` → `diamondsToAward`
   - Change: `SET hearts = COALESCE(hearts, 0) + ?` → `SET diamonds = COALESCE(diamonds, 0) + ?`

3. **New activity types calculated diamonds (lines ~850-860):**
   - Change: `calculatedHearts` → `calculatedDiamonds`
   - Change: `activitySpecificDetails._calculatedHearts` → `activitySpecificDetails._calculatedDiamonds`
   - Change: `SET hearts = COALESCE(hearts, 0) + ?` → `SET diamonds = COALESCE(diamonds, 0) + ?`

### 2.3 `resubmitUploads` function - Dynamic Calculation
**Location:** Lines ~2128-2400

**Changes needed:**
1. **Variable name:** `calculatedHearts` → `calculatedDiamonds` (line 2128)
2. **Same changes as in `uploadFile` function:**
   - Field-level calculation
   - Dropdown option calculation
   - Store calculated value in `activitySpecificDetails._calculatedDiamonds`

---

## 3. Controllers - Review Logic (`flmController.js`)

### 3.1 `reviewUpload` function - Approval Awards
**Location:** Lines ~2612-2731

**Changes needed:**
1. **Brand-based awards (lines ~2621-2674):**
   - Change: `SELECT hearts, diceRolls` → `SELECT diamonds, diceRolls`
   - Change: `brandHearts` → `brandDiamonds`
   - Change: `heartsToAward` → `diamondsToAward`
   - Change: `SET hearts = COALESCE(hearts, 0) + ?` → `SET diamonds = COALESCE(diamonds, 0) + ?`

2. **Camp-based awards (lines ~2678-2715):**
   - Change: `SELECT hearts, diceRolls` → `SELECT diamonds, diceRolls`
   - Change: `campHearts` → `campDiamonds`
   - Change: `heartsToAward` → `diamondsToAward`
   - Change: `SET hearts = COALESCE(hearts, 0) + ?` → `SET diamonds = COALESCE(diamonds, 0) + ?`

3. **New activity types calculated diamonds (lines ~2717-2731):**
   - Change: `activityDetails._calculatedHearts` → `activityDetails._calculatedDiamonds`
   - Change: `calculatedHearts` → `calculatedDiamonds`
   - Change: `SET hearts = COALESCE(hearts, 0) + ?` → `SET diamonds = COALESCE(diamonds, 0) + ?`

### 3.2 `reviewUpload` function - Rejection Subtractions
**Location:** Lines ~2840-2949

**Changes needed:**
1. **Brand-based subtractions (lines ~2843-2895):**
   - Change: `SELECT hearts, diceRolls` → `SELECT diamonds, diceRolls`
   - Change: `brandHearts` → `brandDiamonds`
   - Change: `heartsToSubtract` → `diamondsToSubtract`
   - Change: `SET hearts = GREATEST(COALESCE(hearts, 0) - ?, 0)` → `SET diamonds = GREATEST(COALESCE(diamonds, 0) - ?, 0)`

2. **Camp-based subtractions (lines ~2899-2934):**
   - Change: `SELECT hearts, diceRolls` → `SELECT diamonds, diceRolls`
   - Change: `campHearts` → `campDiamonds`
   - Change: `heartsToSubtract` → `diamondsToSubtract`
   - Change: `SET hearts = GREATEST(COALESCE(hearts, 0) - ?, 0)` → `SET diamonds = GREATEST(COALESCE(diamonds, 0) - ?, 0)`

3. **New activity types calculated diamonds subtraction (lines ~2936-2949):**
   - Change: `activityDetails._calculatedHearts` → `activityDetails._calculatedDiamonds`
   - Change: `calculatedHeartsToSubtract` → `calculatedDiamondsToSubtract`
   - Change: `SET hearts = GREATEST(COALESCE(hearts, 0) - ?, 0)` → `SET diamonds = GREATEST(COALESCE(diamonds, 0) - ?, 0)`

---

## 4. Admin Controller (`adminController.js`)

### 4.1 Activity Type Validation
**Location:** Need to check validation for `activitySpecificFields`

**Changes needed:**
- Add validation for `diamonds` property in field definitions (similar to `hearts`)
- Add validation for `diamonds` property in dropdown options (similar to `hearts`)
- Keep `hearts` validation (for future use)

---

## 5. Summary of Changes

### Database Changes:
1. ✅ `flms` table - Already has `diamonds` field
2. ⚠️ `brands` table - Add `diamonds` field
3. ⚠️ `camps` table - Add `diamonds` field

### Code Changes:
1. **mrController.js:**
   - `uploadFile`: ~15 locations (calculation, storage, awards)
   - `resubmitUploads`: ~15 locations (same as uploadFile)

2. **flmController.js:**
   - `reviewUpload`: ~12 locations (approval awards, rejection subtractions)

3. **adminController.js:**
   - Activity type validation: Add diamonds validation

### Key Patterns to Replace:
- `hearts` → `diamonds` (in variable names, field names, SQL columns)
- `_calculatedHearts` → `_calculatedDiamonds` (in activitySpecificDetails)
- `SELECT hearts` → `SELECT diamonds` (in SQL queries)
- `SET hearts =` → `SET diamonds =` (in UPDATE statements)
- `heartsToAward` → `diamondsToAward`
- `heartsToSubtract` → `diamondsToSubtract`
- `calculatedHearts` → `calculatedDiamonds`

### Important Notes:
- **Keep `hearts` field in all tables** - it will be used for different logic in the future
- **Keep `hearts` property in activitySpecificFields** - for future use
- **All logic for diamonds should be identical to current hearts logic**
- **Test thoroughly:** Auto-approval ON/OFF, approval, rejection, resubmission

---

## 6. Testing Checklist

- [ ] Upload new activity type with diamonds in field definition
- [ ] Upload new activity type with diamonds in dropdown option
- [ ] Upload legacy type (prescription/pob/camp) with brand/camp diamonds
- [ ] Auto-approval ON: Verify diamonds awarded immediately
- [ ] Auto-approval OFF: Verify diamonds awarded on approval
- [ ] Rejection: Verify diamonds subtracted correctly
- [ ] Resubmission: Verify diamonds recalculated correctly
- [ ] Hearts field remains unchanged (for future use)

