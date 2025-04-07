import axios, { AxiosRequestConfig } from "axios"
import { useAuthToken } from "../components/ui/hooks"

/**
 * Example API service that demonstrates how to use the useAuthToken hook
 * for making authenticated API requests.
 */
export class ApiService {
	/**
	 * Makes an authenticated GET request
	 * @param url The URL to request
	 * @param config Additional axios config
	 * @returns The response data
	 */
	static async get<T>(
		url: string,
		getHeaders: () => Promise<Record<string, string>>,
		config?: AxiosRequestConfig,
	): Promise<T> {
		try {
			const headers = await getHeaders()
			const response = await axios.get<T>(url, {
				...config,
				headers: {
					...config?.headers,
					...headers,
				},
			})
			return response.data
		} catch (error) {
			console.error(`Error making GET request to ${url}:`, error)
			throw error
		}
	}

	/**
	 * Makes an authenticated POST request
	 * @param url The URL to request
	 * @param data The data to send
	 * @param config Additional axios config
	 * @returns The response data
	 */
	static async post<T>(
		url: string,
		data: any,
		getHeaders: () => Promise<Record<string, string>>,
		config?: AxiosRequestConfig,
	): Promise<T> {
		try {
			const headers = await getHeaders()
			const response = await axios.post<T>(url, data, {
				...config,
				headers: {
					...config?.headers,
					...headers,
				},
			})
			return response.data
		} catch (error) {
			console.error(`Error making POST request to ${url}:`, error)
			throw error
		}
	}
}

/**
 * Example of how to use the ApiService with the useAuthToken hook in a component
 */
export function useApi() {
	const { getAuthHeaders } = useAuthToken()

	return {
		/**
		 * Makes an authenticated GET request
		 */
		get: <T>(url: string, config?: AxiosRequestConfig) => {
			return ApiService.get<T>(url, getAuthHeaders, config)
		},

		/**
		 * Makes an authenticated POST request
		 */
		post: <T>(url: string, data: any, config?: AxiosRequestConfig) => {
			return ApiService.post<T>(url, data, getAuthHeaders, config)
		},
	}
}
