# Activity Type with Dropdown Options (pointFactor & hearts per option)

## Overview

This feature allows you to create activity types where:
- **Dropdown field**: Each option has its own `pointFactor` and `hearts`
- **Numeric field**: User enters a number
- **Calculation**: `selectedOption.pointFactor × numericValue` and `selectedOption.hearts × numericValue`

## Example: Medicine Type Activity

### API Request to Create Activity Type

```json
POST /api/admin/activity-types
Content-Type: application/json
Authorization: Bearer YOUR_ADMIN_TOKEN

{
  "typeName": "medicine",
  "folderName": "medicines",
  "isActive": true,
  "displayOrder": 10,
  "activitySpecificFields": [
    {
      "fieldName": "medicineType",
      "type": "dropdown",
      "required": true,
      "pointFactor": 0,
      "hearts": 0,
      "options": [
        {
          "value": "tablet",
          "label": "Tablet",
          "pointFactor": 2.0,
          "hearts": 1
        },
        {
          "value": "syrup",
          "label": "Syrup",
          "pointFactor": 3.0,
          "hearts": 1.5
        },
        {
          "value": "injection",
          "label": "Injection",
          "pointFactor": 5.0,
          "hearts": 2
        }
      ]
    },
    {
      "fieldName": "quantity",
      "type": "number",
      "required": true,
      "pointFactor": 0,
      "hearts": 0
    }
  ]
}
```

### How It Works:

1. **User selects dropdown option** (e.g., "Syrup" with pointFactor: 3.0, hearts: 1.5)
2. **User enters quantity** (e.g., 4)
3. **Calculation**:
   - **Points**: 3.0 × 4 = **12 points**
   - **Hearts**: 1.5 × 4 = **6 hearts**

### Test Upload:

**Frontend Form:**
- Activity Type: "medicine"
- Medicine Type: "Syrup" (selected from dropdown)
- Quantity: 4
- Dr Name: "Dr. Test"
- SC Code: "SC001"
- Upload Image: [select file]

**Expected Results:**
- **Points**: 3.0 × 4 = **12 points**
- **Hearts**: 1.5 × 4 = **6 hearts**

---

## Example 2: Sample Activity with Multiple Options

### API Request

```json
POST /api/admin/activity-types
Content-Type: application/json
Authorization: Bearer YOUR_ADMIN_TOKEN

{
  "typeName": "sample",
  "folderName": "samples",
  "isActive": true,
  "displayOrder": 11,
  "activitySpecificFields": [
    {
      "fieldName": "sampleCategory",
      "type": "dropdown",
      "required": true,
      "pointFactor": 0,
      "hearts": 0,
      "options": [
        {
          "value": "premium",
          "label": "Premium Sample",
          "pointFactor": 4.0,
          "hearts": 2
        },
        {
          "value": "standard",
          "label": "Standard Sample",
          "pointFactor": 2.0,
          "hearts": 1
        },
        {
          "value": "basic",
          "label": "Basic Sample",
          "pointFactor": 1.0,
          "hearts": 0.5
        }
      ]
    },
    {
      "fieldName": "numberOfSamples",
      "type": "number",
      "required": true,
      "pointFactor": 0,
      "hearts": 0
    }
  ]
}
```

### Test Cases:

**Test 1: Premium Sample**
- Sample Category: "Premium Sample" (pointFactor: 4.0, hearts: 2)
- Number of Samples: 3
- **Result**: Points = 4.0 × 3 = **12 points**, Hearts = 2 × 3 = **6 hearts**

**Test 2: Standard Sample**
- Sample Category: "Standard Sample" (pointFactor: 2.0, hearts: 1)
- Number of Samples: 5
- **Result**: Points = 2.0 × 5 = **10 points**, Hearts = 1 × 5 = **5 hearts**

**Test 3: Basic Sample**
- Sample Category: "Basic Sample" (pointFactor: 1.0, hearts: 0.5)
- Number of Samples: 10
- **Result**: Points = 1.0 × 10 = **10 points**, Hearts = 0.5 × 10 = **5 hearts**

---

## Example 3: Visit Activity with Visit Type Dropdown

### API Request

```json
POST /api/admin/activity-types
Content-Type: application/json
Authorization: Bearer YOUR_ADMIN_TOKEN

{
  "typeName": "visit",
  "folderName": "visits",
  "isActive": true,
  "displayOrder": 12,
  "activitySpecificFields": [
    {
      "fieldName": "visitType",
      "type": "dropdown",
      "required": true,
      "pointFactor": 0,
      "hearts": 0,
      "options": [
        {
          "value": "regular",
          "label": "Regular Visit",
          "pointFactor": 1.5,
          "hearts": 1
        },
        {
          "value": "followup",
          "label": "Follow-up Visit",
          "pointFactor": 2.0,
          "hearts": 1.5
        },
        {
          "value": "emergency",
          "label": "Emergency Visit",
          "pointFactor": 3.0,
          "hearts": 2
        }
      ]
    },
    {
      "fieldName": "numberOfVisits",
      "type": "number",
      "required": true,
      "pointFactor": 0,
      "hearts": 0
    }
  ]
}
```

### Test Upload:

- Visit Type: "Emergency Visit" (pointFactor: 3.0, hearts: 2)
- Number of Visits: 2
- **Result**: Points = 3.0 × 2 = **6 points**, Hearts = 2 × 2 = **4 hearts**

---

## Dropdown Option Structure

Each option in the dropdown can be:

### Option 1: Simple String (No pointFactor/hearts)
```json
{
  "options": ["Option 1", "Option 2", "Option 3"]
}
```
- Used for simple dropdowns without calculation

### Option 2: Object with pointFactor and hearts
```json
{
  "options": [
    {
      "value": "option1",
      "label": "Option 1",
      "pointFactor": 2.0,
      "hearts": 1
    },
    {
      "value": "option2",
      "label": "Option 2",
      "pointFactor": 3.0,
      "hearts": 1.5
    }
  ]
}
```

**Required fields:**
- `value`: The value sent to backend (required)
- `label`: Display text (optional, defaults to `value`)

**Calculation fields:**
- `pointFactor`: Number to multiply with numeric field value (optional, can be null/undefined)
- `hearts`: Number to multiply with numeric field value (optional, can be null/undefined)

**Note:** If `pointFactor` or `hearts` are not provided, null, or undefined, they are **not used in calculations** (not multiplied by 0). Only explicitly provided values > 0 will be used for calculations.

---

## Calculation Logic

### Backend Logic:

1. **Check for dropdown fields** with options that have `pointFactor` or `hearts`
2. **Find selected option** by matching `value` or `label`
3. **Find numeric fields** in the same activity type
4. **Calculate**:
   - `totalPoints += selectedOption.pointFactor × numericValue`
   - `calculatedHearts += selectedOption.hearts × numericValue`

### Important Notes:

- **Dropdown field's pointFactor/hearts are ignored** when options have their own values
- **Numeric field's pointFactor/hearts are ignored** when dropdown-based calculation is used
- **Multiple numeric fields** will all be multiplied by the selected dropdown option's pointFactor/hearts
- **If dropdown option has no pointFactor/hearts (null/undefined)**, they are **not used** in calculations (not multiplied by 0)
- **pointFactor and hearts can be null or undefined** - if not provided, they are skipped entirely (not set to 0)
- **Only explicitly provided values > 0** will be used for calculations

---

## Frontend Handling

The frontend already supports this structure:

1. **Dropdown rendering**: Handles both string and object options
2. **Value submission**: Sends the `value` field from selected option
3. **Backend lookup**: Backend finds the option by `value` and uses its `pointFactor/hearts`

**No frontend changes needed!** ✅

---

## Complete Test Example

### Step 1: Create Activity Type

```json
POST /api/admin/activity-types
Content-Type: application/json

{
  "typeName": "test-medicine",
  "folderName": "test-medicines",
  "isActive": true,
  "displayOrder": 99,
  "activitySpecificFields": [
    {
      "fieldName": "medicineType",
      "type": "dropdown",
      "required": true,
      "pointFactor": 0,
      "hearts": 0,
      "options": [
        {
          "value": "tablet",
          "label": "Tablet",
          "pointFactor": 2.0,
          "hearts": 1
        },
        {
          "value": "syrup",
          "label": "Syrup",
          "pointFactor": 3.0,
          "hearts": 1.5
        }
      ]
    },
    {
      "fieldName": "quantity",
      "type": "number",
      "required": true,
      "pointFactor": 0,
      "hearts": 0
    }
  ]
}
```

### Step 2: Test Upload from Frontend

1. Select activity type: "test-medicine"
2. Select "Syrup" from dropdown
3. Enter quantity: 5
4. Fill required fields (drName, scCode)
5. Upload image
6. Submit

### Step 3: Expected Results

- **Points**: 3.0 × 5 = **15 points**
- **Hearts**: 1.5 × 5 = **7.5 hearts** (rounded to 8)

---

## cURL Example

```bash
curl -X POST "https://qrqvsrcm-4500.inc1.devtunnels.ms/api/admin/activity-types" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -d '{
    "typeName": "medicine",
    "folderName": "medicines",
    "isActive": true,
    "displayOrder": 10,
    "activitySpecificFields": [
      {
        "fieldName": "medicineType",
        "type": "dropdown",
        "required": true,
        "pointFactor": 0,
        "hearts": 0,
        "options": [
          {
            "value": "tablet",
            "label": "Tablet",
            "pointFactor": 2.0,
            "hearts": 1
          },
          {
            "value": "syrup",
            "label": "Syrup",
            "pointFactor": 3.0,
            "hearts": 1.5
          }
        ]
      },
      {
        "fieldName": "quantity",
        "type": "number",
        "required": true,
        "pointFactor": 0,
        "hearts": 0
      }
    ]
  }'
```

---

## Summary

✅ **Backend**: Updated to support dropdown options with `pointFactor` and `hearts`  
✅ **Frontend**: Already supports object options (no changes needed)  
✅ **Calculation**: `selectedOption.pointFactor × numericValue`  
✅ **Hearts**: `selectedOption.hearts × numericValue`

The system automatically detects when a dropdown option has `pointFactor`/`hearts` and uses them for calculation instead of field-level values.

