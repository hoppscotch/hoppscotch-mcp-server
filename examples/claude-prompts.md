# Example Claude Prompts for Hoppscotch MCP

This document contains example prompts you can use with Claude to interact with Hoppscotch via the MCP server.

## Collection Management

### Create a Simple REST Collection

```
Create a new REST collection called "GitHub API" with a GET request to fetch user information from https://api.github.com/users/{username}
```

### Create a CRUD Collection

```
Create a REST collection called "Blog API" with these endpoints:
- GET /posts - List all posts
- GET /posts/:id - Get single post
- POST /posts - Create new post with title and content
- PUT /posts/:id - Update existing post
- DELETE /posts/:id - Delete post

Use https://api.example.com as the base URL
```

### Organize Collections

```
I have several API collections. Create a folder structure:
- Auth (login, register, refresh-token)
- Users (profile, settings, delete-account)
- Content (posts, comments, likes)

Move my existing collections into these folders
```

## Environment Management

### Create Development Environment

```
Create a development environment with:
- BASE_URL: http://localhost:3000
- API_KEY: <dev-key>
- DEBUG: true
```

### Create Multiple Environments

```
Set up three environments for my API:
1. Local: http://localhost:3000, API_KEY=<local-key>
2. Staging: https://staging.example.com, API_KEY=<staging-key> (mark as secret)
3. Production: https://api.example.com, API_KEY=<prod-key> (mark as secret)
```

### Update Environment Variables

```
Update my production environment to add:
- TIMEOUT: 30000
- RETRY_ATTEMPTS: 3
Keep the existing API_KEY and BASE_URL
```

## Import/Export

### Export for Backup

```
Export all my REST collections as JSON so I can back them up
```

### Export Specific Collection

```
Export my "Payment Gateway" collection as JSON
```

### Import Collections

```
I have this Hoppscotch export JSON:
{... paste JSON ...}

Import it as a new collection
```

## Team Collaboration

### Create Team Collection

```
Create a team collection called "Shared API Tests" for our backend team
```

### List Team Resources

```
Show me all collections in my team workspace, then create a new one for the Analytics API
```

### Create Team Environment

```
Create a team environment called "QA Testing" with:
- QA_SERVER: https://qa.example.com
- TEST_USER: qa@example.com
- TEST_PASS: (mark as secret)
```

## GraphQL Collections

### Create GraphQL Collection

```
Create a GraphQL collection for the GitHub GraphQL API (https://api.github.com/graphql) with:
- A query to fetch my repositories
- A query to fetch user information
- A mutation to star a repository
```

### GraphQL with Variables

```
Create a GraphQL collection with a query that:
- Fetches user information by username
- Uses variables for the username
- Includes fields: name, bio, company, location
```

## Advanced Workflows

### API Documentation Workflow

```
I need to document my API. Export my "User API" collection and create markdown documentation with:
- Endpoint descriptions
- Request/response examples
- Required headers
- Authentication requirements
```

### Migration Workflow

```
I'm migrating from another API client. I have these endpoints to add to Hoppscotch:
[... list of endpoints ...]

Create a collection organized by resource type (users, posts, auth)
```

### Testing Workflow

```
Set up a testing collection for my authentication flow:
1. POST /register - Create new user
2. POST /login - Get access token
3. GET /profile - Verify token works (use token from step 2)
4. POST /refresh - Refresh token
5. POST /logout - Invalidate token
```

## Debugging & Analysis

### Inspect Collection Structure

```
Show me the structure of my "E-commerce API" collection. List all endpoints with their HTTP methods and paths.
```

### Find Specific Request

```
Find the POST request for creating a new user in my collections
```

### Audit Collections

```
Review all my collections and tell me:
- How many collections I have
- How many requests in each
- Which collections might need organization
```

## Data Migration

### Clone Collection for Testing

```
Duplicate my "Production API" collection and rename it to "Testing API" so I can experiment
```

### Reorganize Collections

```
I have too many root-level collections. Organize them by:
- Creating parent folders for each domain (Auth, Users, Products, Orders)
- Moving existing collections into appropriate folders
- Suggest a better naming convention
```

## Environment Workflows

### Switch Environment Context

```
List all my environments and tell me which one would be best for testing the /checkout endpoint
```

### Environment Variables Audit

```
Show me all variables across all my environments and identify:
- Any duplicates
- Any that should be marked as secret
- Any missing variables (e.g., if dev has X but prod doesn't)
```

## Real-World Scenarios

### Scenario 1: New API Integration

```
I'm integrating with Stripe's API. Create:
1. A REST collection called "Stripe API"
2. Endpoints for: customers, charges, refunds
3. Environments for test and live modes with appropriate API keys (mark as secret)
```

### Scenario 2: Microservices Testing

```
We have 5 microservices. Create team collections for:
- Auth Service (port 3001)
- User Service (port 3002)
- Product Service (port 3003)
- Order Service (port 3004)
- Payment Service (port 3005)

Each should have health check endpoint
```

### Scenario 3: API Version Migration

```
We're migrating from API v1 to v2.
1. Export my current "API v1" collection
2. Create a new "API v2" collection with updated endpoints (/v2/ prefix)
3. Create environments for both versions
```

## Tips for Better Prompts

### Be Specific
```
❌ Bad: "Create an API collection"
✅ Good: "Create a REST collection called 'Weather API' with GET /weather endpoint"
```

### Include Context
```
❌ Bad: "Add authentication"
✅ Good: "Add a POST /login endpoint that returns a JWT token, and a GET /profile endpoint that requires the token in Authorization header"
```

### Ask for Organization
```
❌ Bad: "Create these 20 endpoints"
✅ Good: "Create these 20 endpoints organized into logical folders by resource type"
```

### Request Documentation
```
✅ "After creating the collection, explain what each endpoint does and how to use it"
```

## Combining Multiple Operations

### Full Setup

```
I'm starting a new project. Help me set up Hoppscotch:
1. Create a REST collection for my API
2. Add CRUD endpoints for Users and Posts
3. Create dev, staging, and prod environments
4. Show me how to organize this for team collaboration
```

### Complete Migration

```
Migrate my API setup:
1. Export all my current collections
2. Create new organized structure with folders
3. Import into team workspace
4. Set up team environments
5. Document the new structure
```

## Error Handling & Troubleshooting

### If Tool Fails

```
"I got an error when trying to create a collection. Can you check my team ID and try again?"
```

### Verification

```
"After creating those collections, list them all so I can verify they were created correctly"
```

### Cleanup

```
"I made a mistake. Delete the collection with ID [id] and recreate it with the correct settings"
```
