# Reference diagrams

Drop board-layout / valve / wiring diagram images here (PNG, JPG, or WebP).
This folder is git-ignored — images live only on machines/servers you put
them on, not in git history.

## Wiring an image to a knowledge chunk

1. Add the image file to this folder, e.g. `pbc_board_layout.png`.
2. In `server/knowledge_chunks.json`, add an `"image"` field to the chunk(s)
   the diagram illustrates:

   ```json
   {
     "id": "cscp_pbc",
     "topic": "PBC — Programmable BACnet Controller",
     "image": "pbc_board_layout.png",
     ...
   }
   ```

3. Restart the server. When a question retrieves that chunk via RAG, the
   image is attached to the request so the model can see it directly
   (Claude has vision — it isn't just told the filename).

Only add diagrams you already have legitimate access to (e.g. installer/
dealer documentation from Phoenix Controls), and keep this deployment
private to your team — see the disclaimer in the app's Terms of Service
for why.
