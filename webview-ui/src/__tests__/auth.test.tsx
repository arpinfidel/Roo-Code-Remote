import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { initializeApp } from "firebase/app"
import { getAuth, signInWithPopup } from "firebase/auth"
import App from "../App"

// Mock Firebase configuration
const firebaseConfig = {
	apiKey: "test",
	authDomain: "test",
	projectId: "test",
	storageBucket: "test",
	messagingSenderId: "test",
	appId: "test",
	measurementId: "test",
}

// Initialize Firebase
const app = initializeApp(firebaseConfig)
const auth = getAuth(app)

// Mock the signInWithPopup function
jest.mock("firebase/auth", () => ({
	...jest.requireActual("firebase/auth"),
	getAuth: jest.fn(() => auth),
	signInWithPopup: jest.fn(() => Promise.resolve({ user: { email: "test@example.com" } })),
	GoogleAuthProvider: jest.fn(),
}))

describe("Authentication", () => {
	it("should display login button when user is not logged in", () => {
		render(<App />)
		expect(screen.getByText("Login")).toBeInTheDocument()
	})

	it("should display user email when user is logged in", async () => {
		render(<App />)

		// Mock the signInWithPopup function to resolve with a user
		;(signInWithPopup as jest.Mock).mockResolvedValue({ user: { email: "test@example.com" } })

		// Simulate clicking the login button
		fireEvent.click(screen.getByText("Login"))

		// Wait for the user email to be displayed
		await screen.findByText("Logged in as: test@example.com")

		expect(screen.getByText("Logged in as: test@example.com")).toBeInTheDocument()
	})
})
