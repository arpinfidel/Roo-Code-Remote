/**
 * Utility functions for authentication and authorization
 * This file provides helper functions to work with Firebase authentication
 * and generate proper headers for API requests and WebSocket connections.
 */

import { useAuthToken } from '../components/ui/hooks/useAuthToken';

/**
 * Gets the authentication token and returns it as a URL search parameter
 * @param token Optional token to use instead of fetching a new one
 * @returns URLSearchParams object with the auth token
 */
export const getAuthParams = async (token?: string | null): Promise<URLSearchParams> => {
  const params = new URLSearchParams();
  
  if (token) {
    params.set('auth_token', token);
    return params;
  }
  
  // If no token is provided, we'll need to get it from the hook in a component context
  return params;
};

/**
 * Adds authentication parameters to a URL
 * @param url The URL to add authentication parameters to
 * @param token Optional token to use instead of fetching a new one
 * @returns URL with authentication parameters
 */
export const addAuthToUrl = async (url: URL, token?: string | null): Promise<URL> => {
  const authParams = await getAuthParams(token);
  
  // Add each auth parameter to the URL
  authParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });
  
  return url;
};

/**
 * Hook wrapper for getting auth token and adding it to a URL
 * Must be used within a component context
 */
export const useAuthUrl = () => {
  const { token, getAuthHeaders } = useAuthToken();
  
  const addAuthToUrlWithToken = async (url: URL): Promise<URL> => {
    // Get the current token or fetch a new one if needed
    const headers = await getAuthHeaders();
    const authToken = headers.Authorization?.split(' ')[1] || null;
    
    return addAuthToUrl(url, authToken);
  };
  
  return {
    addAuthToUrl: addAuthToUrlWithToken,
    token
  };
};