# Google Places Autocomplete Setup

## Overview
The project creation form now includes Google Places autocomplete for the address field, providing users with easy address suggestions as they type.

## Setup Instructions

### 1. Get a Google Maps API Key
1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the **Places API** for your project
4. Create credentials (API Key)
5. Optionally restrict the API key to your domain for security

### 2. Configure Environment Variable
Add the following environment variable to your deployment:

```bash
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=your_google_maps_api_key_here
```

### 3. For Vercel Deployment
If deploying to Vercel:
1. Go to your project dashboard
2. Navigate to Settings > Environment Variables
3. Add `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` with your API key
4. Redeploy your application

### 4. For Local Development
Create a `.env.local` file in your project root:
```
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=your_actual_api_key_here
```

## Features
- **Real-time suggestions**: As users type, Google provides address suggestions
- **Formatted addresses**: Automatically formats selected addresses
- **Responsive design**: Matches your app's design system
- **Error handling**: Gracefully handles missing API keys (shows regular input field)

## Pricing & Costs

The Google Places API is **not free**, but offers generous free tiers and pay-as-you-go pricing.

### Free Tier (Always Free)
- **$200 monthly credit** automatically applied to your Google Cloud bill
- **40,000 monthly requests** included for free
- No setup fees, no minimums

### Places Autocomplete Pricing
- **Autocomplete requests**: $0.00283 per request (after free tier)
- **Place Details requests**: $0.017 per request
- **Session-based billing**: Reduces costs when users make selections

### Estimated Monthly Costs
For a small construction management app:
- **10-50 projects/month** = **$0.14 - $0.71/month** (way under free tier)
- **100-500 projects/month** = **$1.42 - $7.08/month**
- **1000+ projects/month** = **$14.15+/month** (scales with usage)

### Cost Optimization
- **Session tokens** reduce API calls by grouping autocomplete + place details
- **Geographic restrictions** on API key limit usage to your target areas
- **Caching** can reduce repeated API calls for common addresses

### Getting Started
1. **No upfront costs** - Google gives $200 credit automatically
2. **Pay only for usage** - billed monthly based on actual API calls
3. **Monitor usage** in Google Cloud Console to track costs
4. **Set billing alerts** to avoid unexpected charges

## Troubleshooting

### No Suggestions Appearing
If you don't see address suggestions when typing:

1. **Check API Key**: Verify `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` is set in your environment
2. **Enable Places API**: Make sure Places API is enabled in Google Cloud Console
3. **Check Browser Console**: Look for any JavaScript errors
4. **API Key Restrictions**: Remove any domain restrictions for development
5. **Wait for Script**: The Google Maps script takes a moment to load

### Common Issues
- **"google is not defined"**: Script hasn't loaded yet, wait a few seconds
- **"Invalid API key"**: Check your API key in Google Cloud Console
- **No suggestions**: Places API might not be enabled or restricted

## Technical Details
- Uses `react-google-places-autocomplete` package
- Google Maps JavaScript API script loaded automatically in layout
- Styled to match your existing UI components
- Integrated with React Hook Form for validation
- Graceful fallback to regular input when API key is missing or script hasn't loaded
- Only renders Google Places component on client-side to prevent SSR issues
- Restricted to US addresses and address types for better relevance
