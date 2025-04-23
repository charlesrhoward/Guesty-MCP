# Guesty MCP Server

A Model Context Protocol (MCP) server implementation for integrating with Guesty's Property Management API. This server enables AI assistants like Claude to interact directly with your Guesty account, providing tools for managing properties, reservations, guest communication, and more.

## What is MCP?

The Model Context Protocol (MCP) is a standardized way for AI assistants to interact with external data sources and tools. It defines a message format for communication between clients (AI assistants) and servers (like this one), allowing for tool discovery, invocation, and response handling.

## Features

This MCP server provides the following capabilities for interacting with Guesty:

- **Property Management**
  - List all properties with filtering options
  - Get detailed information about specific properties
  - Check property availability for specific dates

- **Reservation Management**
  - List all reservations with filtering options
  - Get detailed information about specific reservations
  - Create new reservations

- **Guest Communication**
  - Send messages to guests
  - Retrieve guest message history

## Prerequisites

Before setting up this server, you'll need:

1. A Guesty account with API access enabled
2. Client ID and Secret from Guesty's Open API section
3. Node.js (v14 or higher) installed on your system

## Setup Instructions

1. Clone this repository:
   ```
   git clone https://github.com/yourusername/guesty-mcp.git
   cd guesty-mcp
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Create a `.env` file based on the provided `.env.example`:
   ```
   # Guesty API Credentials
   GUESTY_CLIENT_ID=your_client_id_here
   GUESTY_CLIENT_SECRET=your_client_secret_here
   
   # Server Configuration
   PORT=3000
   ```

4. Start the server:
   ```
   npm start
   ```

## Getting Guesty API Credentials

To obtain your Guesty API credentials:

1. Log in to your Guesty account
2. In the top-right corner, click your profile and select "Open API"
3. In the left menu, click "Applications"
4. Click "New application" to create credentials
5. Save both the Client ID and Client Secret (the secret is only shown once)

## Connecting to AI Assistants

This MCP server follows the Model Context Protocol specification, making it compatible with AI assistants that support MCP, such as Claude from Anthropic.

For Claude Desktop:
1. Open Claude Desktop
2. Go to Settings > MCP Servers
3. Add a new MCP server with the URL: `http://localhost:3000/mcp` (adjust if you changed the port)

## Available Tools

The server provides the following tools for Guesty integration:

| MCP Tool | Guesty API Endpoint | Required Arguments | Optional Arguments |
|----------|---------------------|-------------------|-------------------|
| `list_properties` | `GET /listings` | None | `filters`: JSON filters<br>`limit`: Max results<br>`skip`: Pagination offset |
| `get_property` | `GET /listings/{property_id}` | `property_id`: ID of property | `fields`: Specific fields to return |
| `check_availability` | `GET /listings` with availability query | `check_in`: Start date (YYYY-MM-DD)<br>`check_out`: End date (YYYY-MM-DD) | `property_id`: Specific property to check<br>`min_occupancy`: Minimum occupancy |
| `list_reservations` | `GET /reservations` | None | `filters`: JSON filters<br>`limit`: Max results<br>`skip`: Pagination offset |
| `get_reservation` | `GET /reservations/{reservation_id}` | `reservation_id`: ID of reservation | `fields`: Specific fields to return |
| `create_reservation` | `POST /reservations` | `listing_id`: Property ID<br>`check_in_date`: Start date (YYYY-MM-DD)<br>`check_out_date`: End date (YYYY-MM-DD) | `guest_id`: Existing guest ID<br>`guest_data`: New guest info<br>`status`: Reservation status |
| `send_guest_message` | `POST /communications` | `reservation_id`: ID of reservation<br>`message`: Message content | `subject`: Message subject |
| `get_guest_messages` | `GET /communications` | `reservation_id`: ID of reservation | `limit`: Max messages to return |

## Docker Deployment

This server can be easily deployed using Docker:

```bash
# Build the Docker image
docker build -t guesty-mcp-server .

# Run the container with environment variables
docker run -d -p 3000:3000 \
  -e GUESTY_CLIENT_ID=your_actual_client_id \
  -e GUESTY_CLIENT_SECRET=your_actual_client_secret \
  --name guesty-mcp guesty-mcp-server
```

Alternatively, you can use a `.env` file with Docker:

```bash
# Create a .env file with your credentials
cp .env.example .env
# Edit the .env file with your actual credentials

# Run the container with .env file
docker run -d -p 3000:3000 \
  --env-file ./.env \
  --name guesty-mcp guesty-mcp-server
```

## Security Considerations

- This server requires your Guesty API credentials. Keep these secure and never share them.
- When using Docker, prefer using environment variables or secrets instead of building images with credentials.
- The server should ideally run on a secure, local network or with proper authentication if exposed publicly.
- Consider implementing additional security measures like API rate limiting and request validation for production use.

## License

This project is licensed under the MIT License.

## Contributing

### Getting Started

1. Fork & clone the repository
   ```bash
   git clone https://github.com/yourusername/guesty-mcp.git
   cd guesty-mcp
   ```

2. Install dependencies
   ```bash
   npm install
   ```

3. Make your changes

4. Run tests before submitting
   ```bash
   npm run test
   ```
   *Ensures Jest unit tests & TypeScript types pass*

5. Submit a PR with descriptive title + linked issue

We follow [Conventional Commits](https://www.conventionalcommits.org/) specification and use semantic release for versioning.

## Acknowledgments

- Anthropic for the Model Context Protocol specification
- Guesty for their property management platform and API