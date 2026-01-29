
import mido

midi_path = 'backend-api/separated/732bf461/piano.mid'

try:
    mid = mido.MidiFile(midi_path)
    print(f"MIDI Type: {mid.type}")
    print(f"Ticks per beat: {mid.ticks_per_beat}")
    print(f"Number of tracks: {len(mid.tracks)}")
    
    total_notes = 0
    for i, track in enumerate(mid.tracks):
        print(f"Track {i}: {track.name}")
        notes = [msg for msg in track if msg.type == 'note_on']
        print(f"  Note On events: {len(notes)}")
        total_notes += len(notes)
        
    print(f"Total Notes: {total_notes}")

except Exception as e:
    print(f"Error reading MIDI: {e}")
