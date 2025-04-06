# Authentication Hooks

## useAuthToken

A custom hook that provides Firebase authentication tokens and properly formatted headers for authenticated API requests.

### Usage

```tsx
import { useAuthToken } from '../components/ui/hooks';

function MyComponent() {
  const { 
    token,            // The current Firebase ID token
    isLoading,        // Boolean indicating if the token is being fetched
    error,            // Any error that occurred during token fetching
    getAuthHeaders,   // Function that returns headers with the current auth token
    getCustomToken,   // Function to get a custom token from the backend
    refreshToken      // Function to force refresh the token
  } = useAuthToken();

  const fetchData = async () => {
    try {
      // Get headers with the current auth token
      const headers = await getAuthHeaders();
      
      // Use the headers in your fetch request
      const response = await fetch('/api/data', { headers });
      const data = await response.json();
      
      // Process data...
    } catch (error) {
      console.error('Error fetching data:', error);
    }
  };

  return (
    <div>
      {isLoading ? (
        <p>Loading...</p>
      ) : error ? (
        <p>Error: {error.message}</p>
      ) : (
        <button onClick={fetchData}>Fetch Data</button>
      )}
    </div>
  );
}
```

### API

- `token`: The current Firebase ID token, or null if not authenticated
- `isLoading`: Boolean indicating if the token is being fetched
- `error`: Any error that occurred during token fetching
- `getAuthHeaders(forceRefresh?: boolean)`: Function that returns headers with the current auth token
  - `forceRefresh`: Optional boolean to force refresh the token before returning headers
  - Returns: `Promise<{ Authorization: string, 'Content-Type': string }>`
- `getCustomToken(uid: string)`: Function to get a custom token from the backend
  - `uid`: The user ID to get a custom token for
  - Returns: `Promise<string>`
- `refreshToken()`: Function to force refresh the token
  - Returns: `Promise<string | null>`

## Using with API Services

For a complete example of how to use this hook with API services, see the `api-service.ts` file in the `lib` directory.