# Collab Board – WebSocket Server

This repository contains the **real-time WebSocket server** for [Collab Board](https://github.com/milljo3/collab-board).
It is responsible for **real-time syncing** of board data and **user presence** between connected clients.

The server is built with **Express** and **Socket.IO**, with **Redis pub/sub** integration to broadcast updates across all instances.

---

## Table of Contents

* [Overview](#overview)
* [Features](#features)
* [Tech Stack](#tech-stack)
* [Folder Structure](#folder-structure)
* [Challenges Faced](#challenges-faced)
* [Future Improvements](#future-improvements)

---

## Overview

The WebSocket server handles:

* Broadcasting board changes (categories, tasks) to all connected clients
* Tracking and updating **user presence** on a per-board basis
* Listening for Redis pub/sub events to synchronize across multiple server instances
* Acting as a bridge between the Next.js frontend and Redis cache

---

## Features

* **Real-Time Sync**

  * All connected clients receive board updates instantly via Socket.IO events
  * Supports multiple concurrent boards
* **User Presence Tracking**

  * Tracks which users are currently viewing a board
  * Updates presence list in real time
* **Redis Pub/Sub Integration**

  * Publishes board update events to Redis
  * Subscribes to events from Redis to sync changes across instances
* **Scalable Architecture**

  * Stateless server instances connected via Redis
  * Deployed independently from the frontend

---

## Tech Stack

| Area           | Tech                     |
| -------------- | ------------------------ |
| **Backend**    | Express, TypeScript      |
| **Real-Time**  | Socket.IO, Redis pub/sub |
| **Validation** | Zod                      |
| **Security**   | CORS configuration       |
| **Deployment** | Render                   |

---

## Folder Structure

```
/src
  redis.ts          # Redis client
  index.ts          # Express + Socket.IO server
```

---

## Challenges Faced

* **First-time Redis usage** — designing the right event channels and payload structures for pub/sub
* **Socket.IO presence tracking** — ensuring presence lists remain accurate when users disconnect or switch boards
* **Cross-instance sync** — validating that updates on one server reach all clients, even when connected to different instances

---

## Future Improvements

* More granular event types (e.g. typing indicators, comment updates, outlining modified tasks / categories, cursor tracking, visual dragging)
* Metrics/logging for connection and event activity

---

## Related Repository

* **Main App:** [Collab Board](https://github.com/milljo3/collab-board)
